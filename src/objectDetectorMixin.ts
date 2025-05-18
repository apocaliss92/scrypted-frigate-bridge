import sdk, { MediaObject, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { DetectionClass, detectionClassesDefaultMap } from "../../scrypted-advanced-notifier/src/detectionClasses";
import FrigateBridgeObjectDetector from "./objectDetector";
import { AudioType, baseFrigateApi, convertFrigateBoxToScryptedBox, FrigateEvent, FrigateObjectDetection } from "./utils";
import MqttClient from "../../scrypted-apocaliss-base/src/mqtt-client";
import { getBaseLogger, getMqttBasicClient } from "../../scrypted-apocaliss-base/src/basePlugin";

export class FrigateBridgeObjectDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, ObjectDetector {
    storageSettings = new StorageSettings(this, {
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
        },
        labels: {
            title: 'Labels to import',
            type: 'string',
            multiple: true,
            combobox: true,
            choices: [],
            defaultValue: [],
            onGet: async () => {
                return {
                    choices: this.plugin.plugin.labels
                };
            }
        },
        eventTypes: {
            title: 'Event types',
            type: 'string',
            multiple: true,
            combobox: true,
            choices: ['new', 'update', 'end'],
            defaultValue: ['end']
        },
    });

    logger: Console;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeObjectDetector
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;
    }

    getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        const logger = this.getLogger();
        logger.log('getDetectionInput', detectionId);

        const mo = sdk.mediaManager.createMediaObjectFromUrl(`${this.plugin.plugin.storageSettings.values.serverUrl}/events/${detectionId}/snapshot.jpg`);
        return mo;
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return {
            classes: this.plugin.plugin.labels
        };
    }

    async onFrigateDetectionEvent(event: FrigateEvent) {
        const { eventTypes, labels } = this.storageSettings.values;
        const boundingBox: ObjectDetectionResult['boundingBox'] = convertFrigateBoxToScryptedBox(event.after.box);
        const className = detectionClassesDefaultMap[event.after.label] || event.after.label;
        let label;
        if (className !== event.after.label) {
            label = event.after.label;
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
            timestamp: event.after.start_time * 1000,
            detectionId: event.after.id,
            inputDimensions: [0, 0],
            detections: [
                { className: 'motion', score: 1, boundingBox },
                {
                    className,
                    score: event.after.score,
                    boundingBox,
                    label,
                    movement: {
                        moving: event.after.active,
                        firstSeen: event.after.start_time * 1000,
                        lastSeen: event.after.end_time * 1000,
                    },
                    zones: event.after.current_zones,
                },
            ]
        };

        logger.log('Detection event kept', JSON.stringify(detection));
        this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
    }

    async onFrigateAudioEvent(audioType: AudioType, value: any) {
        const { labels } = this.storageSettings.values;
        const className = DetectionClass.Audio;

        const isAudioLevelValue = ['dBFS', 'rms'].includes(audioType);

        const logger = this.getLogger();
        const parsedValue = isAudioLevelValue ? JSON.parse(value) : value;
        if (labels?.includes(audioType) && (isAudioLevelValue || parsedValue === 'ON')) {
            const now = Date.now();
            const detection: FrigateObjectDetection = {
                frigateEvent: { type: 'new' } as FrigateEvent,
                timestamp: now,
                inputDimensions: [0, 0],
                detections: [
                    {
                        className,
                        score: 1,
                        label: audioType
                    },
                ]
            };

            const logMessage = `Audio event kept: ${JSON.stringify(detection)}`;
            if (isAudioLevelValue) {
                logger.debug(logMessage);
            } else {
                logger.log(logMessage);
            }
            this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
        } else {
            logger.debug('Event skipped', audioType, value);
        }
    }

    async getMixinSettings(): Promise<Setting[]> {
        try {
            const classes = await this.getObjectTypes();
            this.storageSettings.settings.labels.choices = classes.classes;
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
            const newLogger = getBaseLogger({
                deviceConsole: this.console,
                storage: this.storageSettings,
            });

            this.logger = newLogger;
        }

        return this.logger;
    }
}
