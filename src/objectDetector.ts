import { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin from "./main";
import { FrigateBridgeObjectDetectorMixin } from "./objectDetectorMixin";
import { FRIGATE_OBJECT_DETECTOR_INTERFACE, FrigateEvent } from "./utils";

export default class FrigateBridgeObjectDetector extends BasePlugin implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
        ...getBaseSettings({
            onPluginSwitch: (_, enabled) => {
                this.startStop(enabled);
            },
            hideHa: true,
            baseGroupName: '',
            mqttAlwaysEnabled: true
        }),
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, FrigateBridgeObjectDetectorMixin> = {};
    plugin: FrigateBridgePlugin;

    constructor(nativeId: string, plugin: FrigateBridgePlugin) {
        super(nativeId, {
            pluginFriendlyName: 'Frigate Object Detector',
        });
        this.plugin = plugin;

        this.startStop(this.storageSettings.values.pluginEnabled).then().catch(this.getLogger().log);
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            await this.stop();
        }
    }

    async stop() {
        await this.mqttClient?.disconnect();
    }

    async start() {
        try {
            await this.startMqttListener();
        } catch (e) {
            this.getLogger().log(`Error in initFlow`, e);
        }
    }

    async startMqttListener() {
        const mqttClient = await this.getMqttClient();
        const logger = this.getLogger();
        const eventsTopic = `frigate/events`;
        const audioTopic = `frigate/+/audio/+`;
        const motionTopic = `frigate/+/motion`;

        await mqttClient.subscribe([eventsTopic, audioTopic, motionTopic], async (messageTopic, message) => {
            if (messageTopic === eventsTopic) {
                const obj: FrigateEvent = JSON.parse(message.toString());
                logger.debug(`Event received: ${JSON.stringify(obj)}`);

                const foundMixin = Object.values(this.currentMixinsMap).find(mixin => {
                    const { cameraName } = mixin.storageSettings.values;

                    return cameraName === obj.after.camera;
                });

                if (foundMixin) {
                    await foundMixin.onFrigateDetectionEvent(obj);
                }
            } else {
                // frigate/salone/audio/speech rms dBFS
                // frigate/salone/motion
                const [_, camera, eventType, eventSubType] = messageTopic.split('/');

                const foundMixin = Object.values(this.currentMixinsMap).find(mixin => {
                    const { cameraName } = mixin.storageSettings.values;

                    return cameraName === camera;
                });

                if (foundMixin) {
                    if (eventType === 'motion') {
                        logger.info(`Motion message received ${messageTopic} ${message}: ${camera}`);
                        await foundMixin.onFrigateMotionEvent(message);
                    } else if (eventType === 'audio') {
                        logger.info(`Audio message received ${messageTopic} ${message}: ${camera} ${eventSubType}`);
                        await foundMixin.onFrigateAudioEvent(eventSubType, message);
                    }
                }
            }
        });
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async getMqttClient() {
        return await super.getMqttClient('scrypted_frigate_object_detector');
    }

    getLogger(device?: ScryptedDeviceBase) {
        let logger = super.getLoggerInternal({});
        if (device) {
            logger = this.currentMixinsMap[device.id]?.getLogger() ?? logger;
        }

        return logger;
    }

    async getSettings() {
        try {
            this.storageSettings.settings.devNotifier.hide = true;
            const settings = await super.getSettings();
            return settings;
        } catch (e) {
            this.getLogger().log('Error in getSettings', e);
            return [];
        }
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        if ((type === ScryptedDeviceType.Camera || type === ScryptedDeviceType.Doorbell) &&
            (interfaces.includes(ScryptedInterface.VideoCamera) || interfaces.includes(ScryptedInterface.Camera))) {
            return [
                ScryptedInterface.Settings,
                // ScryptedInterface.ObjectDetector,
                FRIGATE_OBJECT_DETECTOR_INTERFACE]
        }

        return undefined;
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new FrigateBridgeObjectDetectorMixin({
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Frigate Object Detector',
            groupKey: 'frigateObjectDetector',
        }, this)
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }
}

