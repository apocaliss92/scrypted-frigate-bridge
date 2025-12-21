import sdk, { MediaObject, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgeObjectDetector from "./objectDetector";
import { convertFrigateBoxToScryptedBox, convertFrigatePolygonCoordinatesToScryptedPolygon, ensureMixinsOrder, FrigateEvent, FrigateObjectDetection, guessBestCameraName, initFrigateMixin, pluginId } from "./utils";
import { isAudioLabel, isObjectLabel } from "../../scrypted-advanced-notifier/src/detectionClasses";
import { uniq } from "lodash";

export class FrigateBridgeObjectDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, ObjectDetector {
    storageSettings = new StorageSettings(this, {
        logLevel: {
            ...logLevelSetting,
        },
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            choices: [],
            immediate: true,
            onPut: async (_, cameraName) => {
                await this.setZones(cameraName);
                await this.setZonesWithPath(cameraName);
            },
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
        zonesWithPath: {
            title: 'Zones (with path)',
            readonly: true,
            json: true,
            hide: true
        },
    });

    logger: Console;

    private readonly seenDetectionLogKeys = new Set<string>();
    private seenDetectionLogKeysLastCleanMs = Date.now();
    private readonly seenDetectionLogKeysTtlMs = 2 * 60 * 1000;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeObjectDetector
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;

        const logger = this.getLogger();
        this.init().catch(logger.error);
    }

    private maybeCleanSeenDetectionLogKeys(nowMs = Date.now()) {
        if (nowMs - this.seenDetectionLogKeysLastCleanMs < this.seenDetectionLogKeysTtlMs)
            return;

        this.seenDetectionLogKeys.clear();
        this.seenDetectionLogKeysLastCleanMs = nowMs;
    }

    private makeDetectionLogKey(detectionId: any, detection: ObjectDetectionResult, zonesKey: string): string {
        const className = detection?.className ?? '';
        const label = (detection as any)?.label ?? '';
        return `${detectionId ?? ''}|${className}|${label}|${zonesKey ?? ''}`;
    }

    private shouldLogDetectionsOnce(detectionId: any, detections: ObjectDetectionResult[], zonesKey: string): boolean {
        this.maybeCleanSeenDetectionLogKeys();
        if (!detections?.length)
            return true;

        const keys = detections.map(d => this.makeDetectionLogKey(detectionId, d, zonesKey));
        const hasNew = keys.some(k => !this.seenDetectionLogKeys.has(k));
        if (!hasNew)
            return false;

        for (const k of keys)
            this.seenDetectionLogKeys.add(k);

        return true;
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

    async setZonesWithPath(cameraName: string) {
        const zoneNames: string[] = cameraName
            ? (this.plugin.plugin.storageSettings.values.cameraZones?.[cameraName] ?? [])
            : [];

        const zonesFromStorage = this.plugin.plugin.storageSettings.values.cameraZonesDetails?.[cameraName] ?? {};
        const zonesFromConfig = this.plugin.plugin.config?.cameras?.[cameraName]?.zones ?? {};
        const zonesSource = Object.keys(zonesFromStorage).length ? zonesFromStorage : zonesFromConfig;

        const zonesWithPath = zoneNames.map((name: string) => {
            const zoneDef: any = zonesSource?.[name];
            const coords = zoneDef?.coordinates;

            let path: [number, number][] = [];
            if (coords) {
                try {
                    path = convertFrigatePolygonCoordinatesToScryptedPolygon(coords, {
                        outputScale: 100,
                        clamp: true,
                        close: false,
                    });
                } catch {
                    path = [];
                }
            }

            return {
                name,
                path,
            };
        });

        this.storageSettings.values.zonesWithPath = zonesWithPath;
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
        await this.setZonesWithPath(this.storageSettings.values.cameraName);

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
        const eventLabel = event.after.label;
        const [subLabel, subLabelScore] = event.after.sub_label ?? [];

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
        const detectionId = event.after.id ?? event.before.id;

        // Frigate boxes are [xMin, yMin, xMax, yMax] in pixels for the detect stream.
        // Scrypted expects [x, y, width, height].
        const personBox: ObjectDetectionResult['boundingBox'] = convertFrigateBoxToScryptedBox(event.after.box);

        // Motion box: prefer region (larger area) if available.
        const motionSourceBox = (event.after.region ?? event.after.snapshot?.region ?? event.after.box) as any;
        const motionBox: ObjectDetectionResult['boundingBox'] = convertFrigateBoxToScryptedBox(motionSourceBox);

        // Face box: prefer Frigate snapshot face attribute box if present.
        const snapshotFace = event.after.snapshot?.attributes?.find(a => a?.label === 'face');
        const faceSourceBox = snapshotFace?.box ?? event.after.box;
        const faceBox: ObjectDetectionResult['boundingBox'] = convertFrigateBoxToScryptedBox(faceSourceBox);

        const frigateDetections: ObjectDetectionResult[] = [];

        // Always include a motion detection.
        frigateDetections.push({
            className: 'motion',
            score: 1,
            boundingBox: motionBox,
            zones: event.after.current_zones,
        });

        // Main object detection (e.g. person).
        frigateDetections.push({
            className: eventLabel,
            score: event.after.score,
            boundingBox: personBox,
            movement: {
                moving: event.after.active,
                firstSeen: Math.trunc(event.after.start_time * 1000),
                lastSeen: Math.trunc(event.after.end_time ? event.after.end_time * 1000 : Date.now()),
            },
            zones: event.after.current_zones,
        });

        // If this is a person with a recognized sub_label, emit an additional face detection.
        if (eventLabel === 'person' && subLabel) {
            frigateDetections.push({
                className: 'face',
                score: subLabelScore ?? 1,
                boundingBox: faceBox,
                label: subLabel,
                labelScore: subLabelScore,
                zones: event.after.current_zones,
            });
        }

        const frigateEvent: ObjectsDetected = {
            timestamp,
            inputDimensions: [0, 0],
            detectionId,
            detections: frigateDetections,
        };

        const minimalDetections: ObjectDetectionResult[] = [
            { className: 'motion', score: 1 },
            { className: eventLabel, score: event.after.score },
        ];

        const detection: FrigateObjectDetection = {
            timestamp,
            detections: minimalDetections,
            sourceId: pluginId,
            frigateEvent
        }

        const zonesKey = (event.after.current_zones ?? []).slice().sort().join(',');
        const shouldLog = this.shouldLogDetectionsOnce(detectionId, frigateDetections, zonesKey);
        if (shouldLog) {
            logger.log(`Detection event forwarded, ${JSON.stringify({
                eventLabel,
                subLabel,
                event
            })}`);
        }
        logger.info(JSON.stringify(event));
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
        this.seenDetectionLogKeys.clear();
        this.seenDetectionLogKeysLastCleanMs = Date.now();
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
