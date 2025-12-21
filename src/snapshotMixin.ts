import sdk, { Camera, MediaObject, RequestPictureOptions, ResponsePictureOptions, ScryptedDeviceBase, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgeSnapshot from "./snapshot";
import { guessBestCameraName, pluginId } from "./utils";

export class FrigateBridgeSnapshotMixin extends SettingsMixinDeviceBase<any> implements Settings, Camera {
    storageSettings = new StorageSettings(this, {
        logLevel: {
            ...logLevelSetting,
        },
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            immediate: true,
        },
    });

    logger: Console;
    cameraDevice: ScryptedDeviceBase;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeSnapshot
    ) {
        super(options);
        this.cameraDevice = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(this.id);

        this.plugin.currentMixinsMap[this.id] = this;

        const logger = this.getLogger();
        this.init().catch(logger.error);
    }

    takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        throw new Error("Method not implemented.");
    }

    getPictureOptions(): Promise<ResponsePictureOptions[]> {
        throw new Error("Method not implemented.");
    }

    async init() {
        if (this.pluginId === pluginId) {
            const [_, cameraName] = this.nativeId.split('_');
            await this.storageSettings.putSetting('cameraName', cameraName);
            this.storageSettings.settings.cameraName.readonly = true;
        }

        if (!this.storageSettings.values.cameraName) {
            this.storageSettings.values.cameraName = guessBestCameraName(this.name, this.plugin.plugin.storageSettings.values.cameras);
        }
    }

    getLogger() {
        if (!this.logger) {
            this.logger = getBaseLogger({
                console: this.console,
                storage: this.storageSettings,
            });
        }

        return this.logger;
    }

    async getMixinSettings(): Promise<Setting[]> {
        try {
            this.storageSettings.settings.cameraName.choices = this.plugin.plugin.storageSettings.values.cameras;

            return this.storageSettings.getSettings();
        } catch (e) {
            this.getLogger().log('Error in getMixinSettings', e);
            return [];
        }
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        const [group, ...rest] = key.split(':');
        if (group === this.settingsGroupKey) {
            this.storageSettings.putSetting(rest.join(':'), value);
        } else {
            super.putSetting(key, value);
        }
    }

    async putMixinSetting(key: string, value: string) {
        this.storageSettings.putSetting(key, value);
    }

    async release() {
        const logger = this.getLogger();
        logger.info('Releasing mixin');
    }
}
