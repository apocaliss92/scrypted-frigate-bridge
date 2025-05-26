import sdk, { MotionSensor, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import FrigateBridgeMotionDetector from "./motionDetector";
import { pluginId } from "./utils";

export class FrigateBridgeMotionDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, MotionSensor {
    storageSettings = new StorageSettings(this, {
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            choices: [],
            immediate: true,
        },
    });

    logger: Console;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeMotionDetector
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;
    }

    async onFrigateMotionEvent(value: any) {
        const logger = this.getLogger();
        logger.log('Motion update received', value);
        const newMotionValue = value === 'ON';
        if (newMotionValue !== this.motionDetected) {
            this.motionDetected = newMotionValue;
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        const logger = this.getLogger();
        try {
            this.storageSettings.settings.cameraName.choices = this.plugin.plugin.storageSettings.values.cameras;

            if (this.pluginId === pluginId) {
                const [_, cameraName] = this.nativeId.split('_');
                await this.storageSettings.putSetting('cameraName', cameraName);
                this.storageSettings.settings.cameraName.readonly = true;
            }

            return this.storageSettings.getSettings();
        } catch (e) {
            logger.log('Error in getMixinSettings', e);
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

    getLogger() {
        if (!this.logger) {
            this.logger = this.plugin.plugin.getLogger({
                console: this.console,
                storage: this.storageSettings,
            });
        }

        return this.logger;
    }
}
