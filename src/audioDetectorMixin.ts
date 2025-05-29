import { AudioVolumeControl, AudioVolumes, MotionSensor, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import FrigateBridgeAudioDetector from "./audioDetector";
import { AudioType, pluginId } from "./utils";

export class FrigateBridgeAudioDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, AudioVolumeControl {
    storageSettings = new StorageSettings(this, {
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            choices: [],
            immediate: true,
        },
        updateSeconds: {
            title: 'Minimum update delay',
            description: 'Amount of seconds to wait within updates',
            type: 'number',
            defaultValue: 5,
        },
    });

    logger: Console;
    lastSet: number;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeAudioDetector
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;

        const logger = this.getLogger();
        this.init().catch(logger.error);
    }

    async setAudioVolumes(audioVolumes: AudioVolumes): Promise<void> {
        this.audioVolumes = {
            ...this.audioVolumes,
            ...audioVolumes
        };
    }

    async init() {
        if (this.pluginId === pluginId) {
            const [_, cameraName] = this.nativeId.split('_');
            await this.storageSettings.putSetting('cameraName', cameraName);
            this.storageSettings.settings.cameraName.readonly = true;
        }
    }

    async onFrigateAudioEvent(audioType: AudioType, value: any) {
        const parsedValue = JSON.parse(value);
        const { updateSeconds } = this.storageSettings.values;
        const now = Date.now();

        if (!this.lastSet || now - this.lastSet > 1000 * (updateSeconds - 1)) {
            this.lastSet = now;
            this.setAudioVolumes({
                [audioType]: parsedValue
            });
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        const logger = this.getLogger();
        try {
            this.storageSettings.settings.cameraName.choices = this.plugin.plugin.storageSettings.values.cameras;

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
