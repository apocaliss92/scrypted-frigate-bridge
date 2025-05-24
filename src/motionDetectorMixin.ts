import { MotionSensor, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import FrigateBridgeMotionDetector from "./motionDetector";

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
        logger.log('MOTION RECEIVED', value);
        const newMotionValue = value === 'ON';
        if (newMotionValue !== this.motionDetected) {
            this.motionDetected = newMotionValue;
        }
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

    public getLogger() {
        if (!this.logger) {
            const newLogger = this.plugin.getLoggerInternal({
                console: this.console,
                storage: this.storageSettings,
            });

            this.logger = newLogger;
        }

        return this.logger;
    }
}
