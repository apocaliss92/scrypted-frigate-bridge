import sdk, { MediaObject, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DetectionClass, detectionClassesDefaultMap } from "../../scrypted-advanced-notifier/src/detectionClasses";
import FrigateBridgeObjectDetector from "./objectDetector";
import { AudioType, convertFrigateBoxToScryptedBox, FrigateEvent, FrigateObjectDetection, isAudioLevelValue, pluginId } from "./utils";

export class FrigateBridgeObjectDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, ObjectDetector {
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
            onGet: async () => {
                return {
                    choices: this.plugin.plugin.storageSettings.values.labels
                };
            }
        },
        eventTypes: {
            title: 'Event types',
            type: 'string',
            multiple: true,
            combobox: true,
            immediate: true,
            choices: ['new', 'update', 'end'],
            defaultValue: ['end']
        },
    });

    logger: Console;
    lastAudioLevelsSent: Record<string, number> = {};

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeObjectDetector
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;

        const logger = this.getLogger();
        this.init().catch(logger.error);
    }

    async init() {
        if (this.pluginId === pluginId) {
            const [_, cameraName] = this.nativeId.split('_');
            await this.storageSettings.putSetting('cameraName', cameraName);
            this.storageSettings.settings.cameraName.readonly = true;
        }

        const { labels } = this.storageSettings.values;
        if (labels.some(label => isAudioLevelValue(label))) {
            const fixedLabels = labels.filter(label =>
                !isAudioLevelValue(label)
            );
            await this.storageSettings.putSetting('labels', fixedLabels);
        }
    }

    getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        const logger = this.getLogger();
        logger.log('getDetectionInput', detectionId);

        const mo = sdk.mediaManager.createMediaObjectFromUrl(`${this.plugin.plugin.storageSettings.values.serverUrl}/events/${detectionId}/snapshot.jpg`);
        return mo;
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return {
            classes: this.plugin.plugin.storageSettings.values.labels
        };
    }

    async onFrigateDetectionEvent(event: FrigateEvent) {
        const { eventTypes, labels } = this.storageSettings.values;
        const boundingBox: ObjectDetectionResult['boundingBox'] = convertFrigateBoxToScryptedBox(event.after.box);
        let className = event.after.label;
        const [label, labelScore] = event.after.sub_label ?? [];
        // const className = detectionClassesDefaultMap[event.after.label] || event.after.label;
        // let label;
        // if (className !== event.after.label) {
        //     label = event.after.label;
        // }

        if (className === 'person' && label) {
            className = 'face';
        }

        const logger = this.getLogger();

        if (
            !eventTypes?.length ||
            !labels?.length ||
            !labels.includes(event.after.label) ||
            !eventTypes.includes(event.type)) {

            logger.debug('Event skipped', JSON.stringify(event));
            return;
        }

        const detection: FrigateObjectDetection = {
            frigateEvent: event,
            timestamp: Math.trunc(event.after.start_time * 1000),
            inputDimensions: [0, 0],
            detections: [
                { className: 'motion', score: 1, boundingBox },
                {
                    className,
                    score: event.after.score,
                    boundingBox,
                    label,
                    labelScore,
                    movement: {
                        moving: event.after.active,
                        firstSeen: Math.trunc(event.after.start_time * 1000),
                        lastSeen: Math.trunc(event.after.end_time * 1000),
                    },
                    zones: event.after.current_zones,
                },
            ]
        };

        logger.log('Detection event forwarded', JSON.stringify(detection));
        this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
    }

    async onFrigateAudioEvent(audioType: AudioType, value: any) {
        const { labels, cameraName } = this.storageSettings.values;
        const now = Date.now();

        const logger = this.getLogger();
        if (labels?.includes(audioType) && value === 'ON') {
            const detection: FrigateObjectDetection = {
                frigateEvent: { type: 'new', after: { camera: cameraName } } as FrigateEvent,
                timestamp: now,
                inputDimensions: [0, 0],
                detections: [
                    {
                        className: DetectionClass.Audio,
                        score: 1,
                        label: audioType
                    },
                ]
            };

            const logMessage = `Audio event forwarded: ${JSON.stringify(detection)}`;
            logger.log(logMessage);
            this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
        } else {
            logger.info('Audio event skipped', audioType, value);
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        try {
            const classes = await this.getObjectTypes();
            this.storageSettings.settings.labels.choices = classes.classes;
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
