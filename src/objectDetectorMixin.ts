import sdk, { MediaObject, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import { DetectionClass } from "../../scrypted-advanced-notifier/src/detectionClasses";
import FrigateBridgeObjectDetector from "./objectDetector";
import { AudioType, convertFrigateBoxToScryptedBox, FrigateEvent, FrigateObjectDetection, isAudioLevelValue, pluginId } from "./utils";

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
            onGet: async () => {
                return {
                    choices: this.plugin.plugin.storageSettings.values.labels,
                    defaultValue: this.plugin.plugin.storageSettings.values.labels
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
        if (this.pluginId === pluginId) {
            const [_, cameraName] = this.nativeId.split('_');
            await this.storageSettings.putSetting('cameraName', cameraName);
            this.storageSettings.settings.cameraName.readonly = true;
        }

        await this.updateSettings();
    }

    async updateSettings() {
        const { labels } = this.storageSettings.values;
        if (labels.some(label => isAudioLevelValue(label))) {
            const fixedLabels = labels.filter(label =>
                !isAudioLevelValue(label)
            );
            await this.storageSettings.putSetting('labels', fixedLabels);
        }

        await this.setZones(this.storageSettings.values.cameraName);
    }

    ensureMixinsOrder() {
        const logger = this.getLogger();
        const nvrObjectDetector = sdk.systemManager.getDeviceById('@scrypted/nvr', 'detection')?.id;
        const basicObjectDetector = sdk.systemManager.getDeviceById('@apocaliss92/scrypted-basic-object-detector')?.id;
        let shouldBeMoved = false;
        const thisMixinOrder = this.mixins.indexOf(this.plugin.id);

        if (nvrObjectDetector && this.mixins.indexOf(nvrObjectDetector) > thisMixinOrder) {
            shouldBeMoved = true
        }
        if (basicObjectDetector && this.mixins.indexOf(basicObjectDetector) > thisMixinOrder) {
            shouldBeMoved = true
        }

        if (shouldBeMoved) {
            logger.log('This plugin needs other object detection plugins to come before, fixing');
            setTimeout(() => {
                const currentMixins = this.mixins.filter(mixin => mixin !== this.plugin.id);
                currentMixins.push(this.plugin.id);
                const thisDevice = sdk.systemManager.getDeviceById(this.id);
                thisDevice.setMixins(currentMixins);
            }, 1000);
        }
    }

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        const logger = this.getLogger();

        const url = `${this.plugin.plugin.storageSettings.values.serverUrl}/events/${detectionId}/snapshot.jpg`;
        try {
            const jpeg = await axios.get(url, { responseType: "arraybuffer" });
            const mo = await sdk.mediaManager.createMediaObject(jpeg.data, 'image/jpeg');
            logger.info(`Frigate event ${detectionId} found`);
            return mo;
        } catch (e) {
            logger.info(`Error fetching Frigate event ${detectionId} ${eventId} from ${url}`, e.message);
            return this.mixinDevice.getDetectionInput(detectionId, eventId);
        }
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        let deviceClasses: string[] = [];
        try {
            deviceClasses = (await this.mixinDevice.getObjectTypes())?.classes;
        } catch { }

        return {
            classes: [
                ...deviceClasses,
                ...this.storageSettings.values.labels,
            ]
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
            detectionId: event.after.id,
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
            type: event.type,
            zonesAfter: event.after.current_zones,
            zonesBefore: event.before?.current_zones,
            detection,
        })}`);
        logger.info(JSON.stringify(detection));
        this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
    }

    async onFrigateAudioEvent(audioType: AudioType, value: any) {
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
