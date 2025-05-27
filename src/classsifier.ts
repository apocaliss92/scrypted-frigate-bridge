import { ClusterForkInterface, MediaObject, ObjectDetection, ObjectDetectionGeneratorResult, ObjectDetectionGeneratorSession, ObjectDetectionModel, ObjectDetectionSession, ObjectsDetected, ScryptedDeviceBase, SettingValue, VideoFrame } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin from "./main";

export default class FrigateBridgeClassifier extends ScryptedDeviceBase implements ObjectDetection, ClusterForkInterface {
    initStorage: StorageSettingsDict<string> = {
        logLevel: {
            ...logLevelSetting,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    plugin: FrigateBridgePlugin;
    logger: Console;

    constructor(nativeId: string, plugin: FrigateBridgePlugin, public classifierName: string) {
        super(nativeId);
        this.plugin = plugin;
    }

    forkInterface(forkInterface: unknown, options?: unknown): Promise<ObjectDetection> {
        const logger = this.getLogger();
        logger.log('forkInterface', forkInterface, options);
        throw new Error("Method not implemented.");
    }

    generateObjectDetections(videoFrames: AsyncGenerator<VideoFrame, void> | MediaObject, session: ObjectDetectionGeneratorSession): Promise<AsyncGenerator<ObjectDetectionGeneratorResult, void>> {
        const logger = this.getLogger();
        logger.log('generateObjectDetections');
        throw new Error("Method not implemented.");
    }
    detectObjects(mediaObject: MediaObject, session?: ObjectDetectionSession): Promise<ObjectsDetected> {
        const logger = this.getLogger();
        logger.log('detectObjects');
        throw new Error("Method not implemented.");
    }
    getDetectionModel(settings?: { [key: string]: any; }): Promise<ObjectDetectionModel> {
        const logger = this.getLogger();
        logger.log('getDetectionModel');
        throw new Error("Method not implemented.");
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
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
}

