import sdk, { AudioVolumeControl, AudioVolumes, MediaObject, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import { DetectionClass } from "../../scrypted-advanced-notifier/src/detectionClasses";
import FrigateBridgeAudioDetector from "./audioDetector";
import { AudioType, ensureMixinsOrder, initFrigateMixin, maskForLog, pluginId } from "./utils";
import { uniq } from "lodash";

export class FrigateBridgeAudioDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, AudioVolumeControl, ObjectDetector {
    storageSettings = new StorageSettings(this, {
        logLevel: {
            ...logLevelSetting,
        },
        useAudioVolumes: {
            title: 'Use audio volumes',
            description: 'Enable forwarding audio level/volume updates (rms/dBFS) to Scrypted. When disabled, only audio detections are forwarded.',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
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
        audioDetectionsState: {
            title: 'Audio detections state',
            description: 'Current state from MQTT frigate/audio_detections as an array of { label, timestamp, score }.',
            json: true,
            hide: true,
            defaultValue: [],
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
            logger.info(`Error fetching Frigate audio event ${detectionId} ${eventId} from ${maskForLog(url)}`, e.message);
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
        const logger = this.getLogger();

        const { useAudioVolumes } = this.storageSettings.values;
        if (!useAudioVolumes)
            return;

        const parsedValue = JSON.parse(value);
        const { updateSeconds } = this.storageSettings.values;
        const now = Date.now();

        logger.debug(`Audio level message received ${audioType}: ${parsedValue}`);

        if (!this.lastSet || now - this.lastSet > 1000 * (updateSeconds - 1)) {
            this.lastSet = now;
            this.setAudioVolumes({
                [audioType]: parsedValue
            });
        }
    }

    async onAudioDetectionsSnapshot(labelsMap: Record<string, any>) {
        const { labels } = this.storageSettings.values;
        const logger = this.getLogger();

        if (!labelsMap || typeof labelsMap !== 'object')
            return;

        const now = Date.now();

        const state = Object.entries(labelsMap)
            .filter(([audioLabel]) => labels?.includes(audioLabel))
            .map(([audioLabel, details]) => {
                const score = (typeof details?.score === 'number') ? details.score : 0;
                const ts = (typeof details?.last_detection === 'number')
                    ? Math.trunc(details.last_detection * 1000)
                    : now;

                return {
                    label: audioLabel,
                    timestamp: ts,
                    score,
                };
            })
            .filter(item => item.score > 0)
            .sort((a, b) => b.timestamp - a.timestamp);

        this.storageSettings.values.audioDetectionsState = state;

        logger.info(`Audio detections snapshot stored, ${JSON.stringify(state)}`);

        if (state.length > 0) {
            const timestamp = state[0]?.timestamp ?? now;
            const detection: ObjectsDetected = {
                timestamp,
                inputDimensions: [0, 0],
                sourceId: pluginId,
                detections: state.map(item => ({
                    className: DetectionClass.Audio,
                    score: item.score,
                    label: item.label,
                })),
            };

            logger.debug(`Audio detections forwarded, ${JSON.stringify({
                detection,
            })}`);
            this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
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
        this.storageSettings.values.audioDetectionsState = [];
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
}
