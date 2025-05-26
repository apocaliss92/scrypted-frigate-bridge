import { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin from "./main";
import { FrigateBridgeMotionDetectorMixin } from "./motionDetectorMixin";
import { FRIGATE_MOTION_DETECTOR_INTERFACE } from "./utils";

export default class FrigateBridgeMotionDetector extends ScryptedDeviceBase implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
        logLevel: {
            ...logLevelSetting,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, FrigateBridgeMotionDetectorMixin> = {};
    plugin: FrigateBridgePlugin;
    logger: Console;

    constructor(nativeId: string, plugin: FrigateBridgePlugin) {
        super(nativeId);
        this.plugin = plugin;

        this.startStop(this.plugin.storageSettings.values.pluginEnabled).then().catch(this.getLogger().log);
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            await this.stop();
        }
    }

    async stop() {
    }

    async start() {
        try {
            await this.startMqttListener();
        } catch (e) {
            this.getLogger().log(`Error in initFlow`, e);
        }
    }

    // async maybeEnableMixin(device: ScryptedDevice) {
    //     if (device.pluginId === pluginId && device.nativeId !== birdseyeCameraNativeId) {
    //         super.maybeEnableMixin(device);
    //     } else {
    //         return;
    //     }
    // }

    async startMqttListener() {
        const mqttClient = await this.getMqttClient();
        const logger = this.getLogger();
        const motionTopic = `frigate/+/motion`;

        await mqttClient.subscribe([motionTopic], async (messageTopic, message) => {
            const [_, camera, eventType] = messageTopic.split('/');

            if (eventType === 'motion') {
                // frigate/salone/motion
                logger.info(`Motion message received ${messageTopic} ${message}: ${camera}`);
                const foundMixin = Object.values(this.currentMixinsMap).find(mixin => {
                    const { cameraName } = mixin.storageSettings.values;

                    return cameraName === camera;
                });

                if (foundMixin) {
                    await foundMixin.onFrigateMotionEvent(message);
                }
            }
        });
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async getMqttClient() {
        return await this.plugin.getMqttClient();
    }

    getLogger() {
        if (!this.logger) {
            this.logger = this.plugin.getLogger({
                console: this.console,
                storage: this.storageSettings,
            });
        }

        return this.logger;
    }

    async getSettings() {
        try {
            const settings = await this.storageSettings.getSettings();
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
                ScryptedInterface.MotionSensor,
                FRIGATE_MOTION_DETECTOR_INTERFACE
            ];
        }

        return undefined;
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new FrigateBridgeMotionDetectorMixin({
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Frigate Motion Detector',
            groupKey: 'frigateMotionDetector',
        }, this)
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }
}

