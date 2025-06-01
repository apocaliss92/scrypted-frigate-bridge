import { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { getMqttBasicClient, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin from "./main";
import { FrigateBridgeObjectDetectorMixin } from "./objectDetectorMixin";
import { audioTopic, eventsTopic, FRIGATE_OBJECT_DETECTOR_INTERFACE, FrigateEvent, isAudioLevelValue } from "./utils";
import MqttClient, { MqttMessageCb } from "../../scrypted-apocaliss-base/src/mqtt-client";

export default class FrigateBridgeObjectDetector extends ScryptedDeviceBase implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
        logLevel: {
            ...logLevelSetting,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, FrigateBridgeObjectDetectorMixin> = {};
    plugin: FrigateBridgePlugin;
    logger: Console;
    mqttCb: MqttMessageCb;
    initializingMqtt = false;
    public mqttClient: MqttClient;

    constructor(nativeId: string, plugin: FrigateBridgePlugin) {
        super(nativeId);
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
        const logger = this.getLogger();
        logger.log('Stopping ObjectDetector listeners');
        await this.mqttClient?.disconnect();
    }

    async start() {
        try {
            const logger = this.getLogger();
            logger.log('Starting ObjectDetector listeners');
            await this.startMqttListener();
        } catch (e) {
            this.getLogger().log(`Error in initFlow`, e);
        }
    }

    async startMqttListener() {
        const mqttClient = await this.getMqttClient();
        const logger = this.getLogger();

        this.mqttCb = async (messageTopic, message) => {
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
                const [_, camera, eventType, eventSubType] = messageTopic.split('/');

                if (eventType === 'audio' && !isAudioLevelValue(eventSubType) && eventSubType !== 'state') {
                    // frigate/salone/audio/speech
                    logger.info(`Audio message received ${messageTopic} ${message}: ${camera} ${eventSubType}`);
                    const foundMixin = Object.values(this.currentMixinsMap).find(mixin => {
                        const { cameraName } = mixin.storageSettings.values;

                        return cameraName === camera;
                    });

                    if (foundMixin) {
                        await foundMixin.onFrigateAudioEvent(eventSubType, message);
                    }
                }
            }
        };

        await mqttClient?.subscribe([eventsTopic, audioTopic], this.mqttCb);
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    private async setupMqttClient() {
        const { useMqttPluginCredentials, pluginEnabled } = this.plugin.storageSettings.values;
        if (pluginEnabled) {
            this.initializingMqtt = true;
            const logger = this.getLogger();

            if (this.mqttClient) {
                this.mqttClient.disconnect();
                this.mqttClient = undefined;
            }

            try {
                this.mqttClient = await getMqttBasicClient({
                    logger,
                    useMqttPluginCredentials,
                    mqttHost: this.plugin.storageSettings.getItem('mqttHost'),
                    mqttUsename: this.plugin.storageSettings.getItem('mqttUsename'),
                    mqttPassword: this.plugin.storageSettings.getItem('mqttPassword'),
                    clientId: 'scrypted_frigate_object_detectoor',
                });
            } catch (e) {
                logger.log('Error setting up MQTT client', e);
            } finally {
                this.initializingMqtt = false;
            }
        }
    }

    async getMqttClient() {
        if (!this.mqttClient && !this.initializingMqtt) {
            await this.setupMqttClient();
        }

        return this.mqttClient;
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
                ScryptedInterface.ObjectDetector,
                FRIGATE_OBJECT_DETECTOR_INTERFACE
            ];
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

