import sdk, { AudioVolumeControl, AudioVolumes, MediaObject, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import { DetectionClass } from "../../scrypted-advanced-notifier/src/detectionClasses";
import FrigateBridgeAudioDetector from "./audioDetector";
import { AudioType, ensureMixinsOrder, initFrigateMixin, pluginId } from "./utils";
import { uniq } from "lodash";

export class FrigateBridgeAudioDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, AudioVolumeControl, ObjectDetector {
    storageSettings = new StorageSettings(this, {
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            choices: [],
            immediate: true,
        },
        labels: {
            title: 'Labels to import',
            type: 'string',
            multiple: true,
            combobox: true,
            immediate: true,
            choices: [],
            defaultValue: [],
        },
        updateSeconds: {
            title: 'Minimum update delay',
            description: 'Amount of seconds to wait within audio level updates',
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

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        const logger = this.getLogger();

        const url = `${this.plugin.plugin.storageSettings.values.serverUrl}/events/${detectionId}/snapshot.jpg`;
        try {
            const jpeg = await axios.get(url, { responseType: "arraybuffer" });
            const mo = await sdk.mediaManager.createMediaObject(jpeg.data, 'image/jpeg');
            logger.info(`Frigate audio event ${detectionId} found`);
            return mo;
        } catch (e) {
            logger.info(`Error fetching Frigate audio event ${detectionId} ${eventId} from ${url}`, e.message);
            return this.mixinDevice.getDetectionInput(detectionId, eventId);
        }
    }

    async setAudioVolumes(audioVolumes: AudioVolumes): Promise<void> {
        this.audioVolumes = {
            ...this.audioVolumes,
            ...audioVolumes
        };
    }

    async init() {
        const logger = this.getLogger();
        ensureMixinsOrder({
            mixin: this,
            plugin: this.plugin.plugin,
            logger,
        });
        await initFrigateMixin({
            mixin: this,
            storageSettings: this.storageSettings,
            plugin: this.plugin.plugin,
            logger,
        });

        const { audioLabels } = this.plugin.plugin.storageSettings.values;
        this.storageSettings.settings.labels.choices = audioLabels;
        this.storageSettings.settings.labels.defaultValue = audioLabels;
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        let deviceClasses: string[] = [];
        try {
            deviceClasses = (await this.mixinDevice.getObjectTypes())?.classes;
        } catch { }

        return {
            classes: uniq([
                ...deviceClasses,
                ...this.storageSettings.values.labels,
            ])
        };
    }

    async onAudioLevelReceived(audioType: AudioType, value: any) {
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

    async onAudioEventReceived(audioType: AudioType, value: any) {
        const { labels } = this.storageSettings.values;
        const now = Date.now();

        const logger = this.getLogger();
        if (labels?.includes(audioType) && value === 'ON') {
            const detection: ObjectsDetected = {
                timestamp: now,
                inputDimensions: [0, 0],
                sourceId: pluginId,
                detections: [
                    {
                        className: DetectionClass.Audio,
                        score: 1,
                        label: audioType
                    },
                ]
            }

            logger.log(`Audio event forwarded, ${JSON.stringify({
                detection,
            })}`);
            this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
        } else {
            logger.info('Audio event skipped', audioType, value);
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        const logger = this.getLogger();
        try {
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
