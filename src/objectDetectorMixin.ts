import sdk, { MediaObject, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgeObjectDetector from "./objectDetector";
import { convertFrigateBoxToScryptedBox, convertFrigatePolygonCoordinatesToScryptedPolygon, ensureMixinsOrder, FrigateEvent, FrigateEventInner, FrigateObjectDetection, guessBestCameraName, initFrigateMixin, pluginId } from "./utils";
import { isAudioLabel, isObjectLabel } from "../../scrypted-advanced-notifier/src/detectionClasses";
import { uniq } from "lodash";
import { FrigateActiveTotalCounts, FrigateObjectCountsMap } from "./mqttSettingsTypes";

export class FrigateBridgeObjectDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, ObjectDetector {
    storageSettings = new StorageSettings<string>(this, {
        logLevel: {
            ...logLevelSetting,
        },
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            choices: [],
            immediate: true,
            onPut: async (_, cameraName) => {
                await this.syncZoneSettings(cameraName);
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
        activeObjects: {
            title: 'Active objects',
            description: 'Object counts from MQTT (frigate/<camera>/<object> and .../active).',
            json: true,
            defaultValue: {},
            subgroup: 'Raw data',
        },
        zoneActiveObjectMap: {
            title: 'Zone active object map',
            description: 'Object counts per zone from MQTT (frigate/<zone>/<object> and .../active), routed to this camera using main.cameraZones.',
            json: true,
            defaultValue: {},
            subgroup: 'Raw data',
        },
    });

    logger: Console;

    public onFrigateCameraObjectCountsUpdate(objectName: string, patch: Partial<FrigateActiveTotalCounts>) {
        if (!objectName)
            return;

        const current = (this.storageSettings.values.activeObjects ?? {}) as FrigateObjectCountsMap;
        const existing = current?.[objectName];
        const nextCounts: FrigateActiveTotalCounts = {
            active: existing?.active ?? 0,
            total: existing?.total ?? 0,
            ...patch,
        };

        const next: FrigateObjectCountsMap = {
            ...current,
            [objectName]: nextCounts,
        };

        this.storageSettings.values.activeObjects = next as any;
    }

    public onFrigateCameraZoneObjectCountsUpdate(zoneName: string, objectName: string, patch: Partial<FrigateActiveTotalCounts>) {
        if (!zoneName || !objectName)
            return;

        const current = (this.storageSettings.values.zoneActiveObjectMap ?? {}) as Record<string, FrigateObjectCountsMap>;
        const currentZone = current?.[zoneName] ?? {};
        const existing = currentZone?.[objectName];
        const nextCounts: FrigateActiveTotalCounts = {
            active: existing?.active ?? 0,
            total: existing?.total ?? 0,
            ...patch,
        };

        const nextZone: FrigateObjectCountsMap = {
            ...currentZone,
            [objectName]: nextCounts,
        };

        const next = {
            ...current,
            [zoneName]: nextZone,
        };

        this.storageSettings.values.zoneActiveObjectMap = next as any;
    }

    private readonly seenDetectionLogKeys = new Set<string>();
    private seenDetectionLogKeysLastCleanMs = Date.now();
    private readonly seenDetectionLogKeysTtlMs = 2 * 60 * 1000;

    private readonly zoneSettingPrefix = 'zone:';

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

    private zoneTypeKey(zoneName: string) {
        return `${this.zoneSettingPrefix}${zoneName}:type`;
    }

    private zonePathKey(zoneName: string) {
        return `${this.zoneSettingPrefix}${zoneName}:path`;
    }

    private clearZoneSettings() {
        for (const key of Object.keys(this.storageSettings.settings as any)) {
            if (key.startsWith(this.zoneSettingPrefix))
                delete (this.storageSettings.settings as any)[key];
        }
    }

    private ensureDynamicStorageSetting(key: string, setting: any) {
        (this.storageSettings.settings as any)[key] = setting;

        if (!(key in (this.storageSettings.values as any))) {
            const rawGet = () => this.storageSettings.device.storage.getItem(key);
            const get = setting.type !== 'clippath'
                ? () => this.storageSettings.getItem(key as any)
                : () => {
                    try {
                        const raw = rawGet();
                        if (!raw)
                            return undefined;
                        return JSON.parse(raw);
                    }
                    catch {
                        return undefined;
                    }
                };

            Object.defineProperty(this.storageSettings.values as any, key, {
                get,
                set: (value: any) => this.storageSettings.putSetting(key, value),
                enumerable: true,
                configurable: true,
            });
        }

        if (!(key in (this.storageSettings.hasValue as any))) {
            Object.defineProperty(this.storageSettings.hasValue as any, key, {
                get: () => this.storageSettings.device.storage.getItem(key) != null,
                enumerable: true,
                configurable: true,
            });
        }
    }

    private getZoneNames(cameraName: string): string[] {
        return cameraName
            ? (this.plugin.plugin.storageSettings.values.cameraZones?.[cameraName] ?? [])
            : [];
    }

    private getZonesSource(cameraName: string): any {
        const zonesFromStorage = this.plugin.plugin.storageSettings.values.cameraZonesDetails?.[cameraName] ?? {};
        const zonesFromConfig = this.plugin.plugin.config?.cameras?.[cameraName]?.zones ?? {};
        return Object.keys(zonesFromStorage).length ? zonesFromStorage : zonesFromConfig;
    }

    private computeZonePath(zonesSource: any, zoneName: string): [number, number][] {
        const zoneDef: any = zonesSource?.[zoneName];
        const coords = zoneDef?.coordinates;

        if (!coords)
            return [];

        try {
            return convertFrigatePolygonCoordinatesToScryptedPolygon(coords, {
                outputScale: 100,
                clamp: true,
                close: false,
            });
        }
        catch {
            return [];
        }
    }

    async syncZoneSettings(cameraName: string) {
        const zoneNames = this.getZoneNames(cameraName);
        const zonesSource = this.getZonesSource(cameraName);

        this.storageSettings.values.zones = zoneNames;
        (this.storageSettings.settings as any).zones.choices = zoneNames;

        this.clearZoneSettings();

        for (const zoneName of zoneNames) {
            const zoneSubgroup = `Zone: ${zoneName}`;
            const typeKey = this.zoneTypeKey(zoneName);
            const pathKey = this.zonePathKey(zoneName);

            this.ensureDynamicStorageSetting(typeKey, {
                title: 'Type',
                type: 'string',
                choices: ['Default', 'Include', 'Exclude'],
                defaultValue: 'Default',
                subgroup: zoneSubgroup,
                immediate: true,
            });

            this.ensureDynamicStorageSetting(pathKey, {
                title: 'Path',
                description: 'Do not edit on scrypted, do it on Frigate if necessary',
                type: 'clippath',
                subgroup: zoneSubgroup,
                immediate: true,
            });

            if (this.storageSettings.device.storage.getItem(typeKey) == null)
                await this.storageSettings.putSetting(typeKey, 'Default');

            if (this.storageSettings.device.storage.getItem(pathKey) == null) {
                const path = this.computeZonePath(zonesSource, zoneName);
                await this.storageSettings.putSetting(pathKey, path);
            }
        }
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

        await this.syncZoneSettings(this.storageSettings.values.cameraName);

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

        const frigateEvent: FrigateEventInner = {
            timestamp,
            inputDimensions: [0, 0],
            detectionId,
            detections: frigateDetections,
            sourceEvent: event,
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
