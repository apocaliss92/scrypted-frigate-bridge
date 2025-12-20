import sdk, { MediaObject, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import FrigateBridgeObjectDetector from "./objectDetector";
import { convertFrigateBoxToScryptedBox, ensureMixinsOrder, FrigateEvent, FrigateObjectDetection, guessBestCameraName, initFrigateMixin, pluginId } from "./utils";
import { isAudioLabel, isObjectLabel } from "../../scrypted-advanced-notifier/src/detectionClasses";
import { uniq } from "lodash";

export class FrigateBridgeObjectDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, ObjectDetector {
    storageSettings = new StorageSettings(this, {
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            choices: [],
            immediate: true,
            onPut: async (_, cameraName) => await this.setZones(cameraName),
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
        eventTypes: {
            title: 'Event types',
            type: 'string',
            multiple: true,
            combobox: true,
            immediate: true,
            choices: ['new', 'update', 'end'],
            defaultValue: ['new', 'update']
        },
        zones: {
            title: 'Zones',
            multiple: true,
            readonly: true,
            choices: [],
        },
    });

    logger: Console;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeObjectDetector
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;

        const logger = this.getLogger();
        this.init().catch(logger.error);
    }

    async setZones(cameraName: string) {
        let zones: string[] = [];
        if (cameraName) {
            zones = this.plugin.plugin.storageSettings.values.cameraZones?.[cameraName] ?? [];
        } else {
            zones = [];
        }

        this.storageSettings.values.zones = zones;
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

        await this.setZones(this.storageSettings.values.cameraName);

        const { labels, cameraName } = this.storageSettings.values;

        const missingLabels = labels.filter(isAudioLabel);
        if (missingLabels.length) {
            const message = `Audio labels were moved to the Frigate audio detector mixin: camera ${cameraName} missingLabels ${missingLabels.join(',')}`;
            logger.error(message);
            this.plugin.plugin.log.a(message);
            this.storageSettings.values.labels = labels.filter(isObjectLabel);
        }

        const { objectLabels } = this.plugin.plugin.storageSettings.values;
        this.storageSettings.settings.labels.choices = objectLabels;
        this.storageSettings.settings.labels.defaultValue = objectLabels;
    }

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        const logger = this.getLogger();

        const url = `${this.plugin.plugin.storageSettings.values.serverUrl}/events/${detectionId}/snapshot.jpg`;
        try {
            const jpeg = await axios.get(url, { responseType: "arraybuffer" });
            const mo = await sdk.mediaManager.createMediaObject(jpeg.data, 'image/jpeg');
            logger.info(`Frigate object event ${detectionId} found`);
            return mo;
        } catch (e) {
            logger.info(`Error fetching Frigate object event ${detectionId} ${eventId} from ${url}`, e.message);
            return this.mixinDevice.getDetectionInput(detectionId, eventId);
        }
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

    async onFrigateDetectionEvent(event: FrigateEvent) {
        const { eventTypes, labels } = this.storageSettings.values;
        const boundingBox: ObjectDetectionResult['boundingBox'] = convertFrigateBoxToScryptedBox(event.after.box);
        let className = event.after.label;
        const [label, labelScore] = event.after.sub_label ?? [];

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

        const timestamp = Math.trunc(event.after.start_time * 1000);
        const score = event.after.score;

        const frigateEvent: ObjectsDetected = {
            timestamp,
            inputDimensions: [0, 0],
            detectionId: event.after.id ?? event.before.id,
            detections: [
                { className: 'motion', score: 1, boundingBox },
                {
                    className,
                    score,
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
        }

        const detection: FrigateObjectDetection = {
            timestamp,
            detections: [
                { className: 'motion', score: 1 },
                {
                    className,
                    score,
                },
            ],
            sourceId: pluginId,
            frigateEvent
        }

        logger.log(`Detection event forwarded, ${JSON.stringify({
            className,
            label,
            event,
            detection,
        })}`);
        logger.info(JSON.stringify(detection));
        this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
    }

    async getMixinSettings(): Promise<Setting[]> {
        try {
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
