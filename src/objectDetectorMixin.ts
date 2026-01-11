import sdk, { MediaObject, MotionSensor, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, ScryptedInterface, Sensors, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import { uniq } from "lodash";
import { detectionClassesDefaultMap, isAudioLabel, isObjectLabel } from "../../scrypted-advanced-notifier/src/detectionClasses";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import { FrigateActiveTotalCounts } from "./mqttSettingsTypes";
import FrigateBridgeObjectDetector from "./objectDetector";
import { buildOccupancyZoneId, convertFrigatePolygonCoordinatesToScryptedPolygon, ensureMixinsOrder, FrigateEvent, initFrigateMixin, pluginId } from "./utils";

export class FrigateBridgeObjectDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, ObjectDetector, Sensors {
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
        boxExtensionPercent: {
            title: 'Bounding box extension (%)',
            type: 'number',
            description: 'Percentage to extend bounding boxes (default: 10)',
            defaultValue: '10',
            immediate: true,
        },
    });

    inputDimensions: [number, number];
    logger: Console;

    private motionDetectedResetTimeout?: ReturnType<typeof setTimeout>;

    private cameraObjectCounts: Record<string, Partial<FrigateActiveTotalCounts>> = {};
    private zoneObjectCounts: Record<string, Record<string, Partial<FrigateActiveTotalCounts>>> = {};

    public onFrigateCameraObjectCountsUpdate(objectName: string, patch: Partial<FrigateActiveTotalCounts>) {
        if (!objectName)
            return;

        const existing = this.cameraObjectCounts?.[objectName];
        const nextCounts: Partial<FrigateActiveTotalCounts> = {
            ...(existing ?? {}),
            ...(patch ?? {}),
        };

        this.cameraObjectCounts = {
            ...(this.cameraObjectCounts ?? {}),
            [objectName]: nextCounts,
        };
        this.syncCameraActiveObjectSettings().catch(() => { });
    }

    public onFrigateCameraZoneObjectCountsUpdate(zoneName: string, objectName: string, patch: Partial<FrigateActiveTotalCounts>) {
        if (!zoneName || !objectName)
            return;

        const persistedAllZones = this.zoneObjectCounts ?? {};
        const persistedZone = persistedAllZones?.[zoneName] ?? {};
        const existing = persistedZone?.[objectName];
        const nextCounts: Partial<FrigateActiveTotalCounts> = {
            ...(existing ?? {}),
            ...(patch ?? {}),
        };

        const nextZone: Record<string, Partial<FrigateActiveTotalCounts>> = {
            ...persistedZone,
            [objectName]: nextCounts,
        };

        const nextAllZones = {
            ...persistedAllZones,
            [zoneName]: nextZone,
        };
        this.zoneObjectCounts = nextAllZones;

        const cameraZones = this.getZoneNames(this.storageSettings.values.cameraName);
        if (!cameraZones.includes(zoneName))
            return;

        const zonesSource = this.getZonesSource(this.storageSettings.values.cameraName);
        const allowedClasses = this.getZoneAllowedClasses(zonesSource, zoneName);
        this.syncZoneActiveObjectSettings(zoneName, `Zone: ${zoneName}`, allowedClasses).catch(() => { });
    }

    private readonly seenDetectionLogKeys = new Set<string>();
    private seenDetectionLogKeysLastCleanMs = Date.now();
    private readonly seenDetectionLogKeysTtlMs = 2 * 60 * 1000;

    private readonly detectionInputCache = new Map<string, {
        expiresAtMs: number;
        value?: MediaObject;
        inFlight?: Promise<MediaObject>;
    }>();
    private detectionInputCacheLastCleanMs = Date.now();
    private readonly detectionInputCacheTtlMs = 5 * 60 * 1000;
    private readonly detectionInputCacheCleanIntervalMs = 60 * 1000;
    private readonly detectionInputCacheMaxEntries = 250;

    private readonly zoneSettingPrefix = 'zone:';

    private cleanupLegacyActiveObjectSettings() {
        // Remove from settings schema (in case it was created dynamically previously).
        for (const key of Object.keys(this.storageSettings.settings)) {
            if (key.startsWith('activeObject:') || /^zone:.*:activeObject:/.test(key))
                delete this.storageSettings.settings[key];
        }

        // Remove deprecated persisted payload settings.
        delete this.storageSettings.settings['activeObjects'];
        delete this.storageSettings.settings['zoneActiveObjectMap'];
        delete this.storageSettings.settings['zonesWithPath'];

        // Remove from persisted device storage.
        const storage: any = this.storageSettings.device?.storage as any;
        if (!storage)
            return;

        const hasKeyEnum = typeof storage.length === 'number' && typeof storage.key === 'function';
        const hasRemove = typeof storage.removeItem === 'function';
        if (!hasKeyEnum || !hasRemove)
            return;

        // Collect first, then delete: deleting while iterating can shift indices.
        const keysToRemove: string[] = [];
        for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (!k)
                continue;
            if (k.startsWith('activeObject:') || /^zone:.*:activeObject:/.test(k))
                keysToRemove.push(k);
            if (k === 'activeObjects' || k === 'zoneActiveObjectMap' || k === 'zonesWithPath')
                keysToRemove.push(k);
        }

        for (const k of keysToRemove) {
            try {
                storage.removeItem(k);
            }
            catch {
                // ignore
            }
        }
    }

    private getAllCounts(map: Record<string, Partial<FrigateActiveTotalCounts>>): Partial<FrigateActiveTotalCounts> | undefined {
        // Frigate publishes an "all" counter that represents the grand total.
        // Per spec: never add other counters for totals.
        const all = map?.all;
        if (!all)
            return undefined;
        const hasActive = typeof all.active === 'number';
        const hasTotal = typeof all.total === 'number';
        if (!hasActive && !hasTotal)
            return undefined;
        return all;
    }

    private setSensorValue(sensorId: string, newValue: string | number) {
        const current = this.sensors?.[sensorId]?.value;
        if (current === newValue)
            return;



        this.sensors = {
            ...this.sensors,
            [sensorId]: {
                name: sensorId,
                value: newValue,
            },
        }
    }

    private writeOccupancySensors(
        ids: { movingId: string; staticId: string; totalId: string },
        counts: Partial<FrigateActiveTotalCounts> | undefined,
    ) {
        const hasTotal = typeof counts?.total === 'number';
        const hasActive = typeof counts?.active === 'number';

        // Never default missing values to 0: update only when MQTT provided real values.
        if (hasTotal)
            this.setSensorValue(ids.totalId, counts!.total!);

        if (!hasTotal || !hasActive)
            return;

        const total = counts!.total!;
        const live = counts!.active!;

        // Treat "moving" as the live count coming from MQTT.
        const moving = Math.min(live, total);
        const stationary = Math.max(0, total - moving);

        this.setSensorValue(ids.movingId, moving);
        this.setSensorValue(ids.staticId, stationary);
    }

    private aggregateCountsByDetectionClass(map: Record<string, Partial<FrigateActiveTotalCounts>>): Record<string, Partial<FrigateActiveTotalCounts>> {
        const aggregated: Record<string, Partial<FrigateActiveTotalCounts>> = {};
        for (const [objectName, counts] of Object.entries(map ?? {})) {
            const cls = detectionClassesDefaultMap[objectName];
            if (!cls)
                continue;

            const prev = aggregated[cls] ?? {};
            const next: Partial<FrigateActiveTotalCounts> = { ...prev };

            if (typeof counts?.active === 'number')
                next.active = (typeof prev.active === 'number' ? prev.active : 0) + counts.active;

            if (typeof counts?.total === 'number')
                next.total = (typeof prev.total === 'number' ? prev.total : 0) + counts.total;

            aggregated[cls] = next;
        }
        return aggregated;
    }

    private async syncCameraActiveObjectSettings() {
        const aggregated = this.aggregateCountsByDetectionClass(this.cameraObjectCounts);

        // Update only classes that have at least one MQTT-provided field.
        const classNames = Object.keys(aggregated).sort();

        // Per-class occupancy.
        for (const cls of classNames) {
            const counts = aggregated[cls];
            const { movingId, staticId, totalId } = buildOccupancyZoneId({ className: cls });
            this.writeOccupancySensors({ movingId, staticId, totalId }, counts);
        }

        // Totals across all classes.
        const cameraTotals = this.getAllCounts(this.cameraObjectCounts);
        const { movingId, staticId, totalId } = buildOccupancyZoneId({});
        this.writeOccupancySensors({ movingId, staticId, totalId }, cameraTotals);
    }

    private getZoneAllowedClasses(zonesSource: any, zoneName: string): Set<string> | undefined {
        const zoneDef: any = zonesSource?.[zoneName];
        const objects = zoneDef?.objects;
        if (!Array.isArray(objects) || !objects.length)
            return undefined;

        const allowed = new Set<string>();
        for (const objectName of objects) {
            const cls = detectionClassesDefaultMap[objectName];
            if (cls)
                allowed.add(cls);
        }
        return allowed;
    }

    private async syncZoneActiveObjectSettings(zoneName: string, _zoneSubgroup: string, allowedClasses?: Set<string>) {
        const zoneCounts = this.zoneObjectCounts?.[zoneName] ?? {};
        const aggregated = this.aggregateCountsByDetectionClass(zoneCounts);

        // Update only classes that have at least one MQTT-provided field.
        const classNames = (allowedClasses
            ? Object.keys(aggregated).filter(cls => allowedClasses.has(cls))
            : Object.keys(aggregated)
        ).sort();

        // Per-class occupancy.
        for (const cls of classNames) {
            const counts = aggregated[cls];
            const { movingId, staticId, totalId } = buildOccupancyZoneId({ zoneName, className: cls });
            this.writeOccupancySensors({ movingId, staticId, totalId }, counts);
        }

        // Zone grand totals: always use Frigate's "all" counter.
        const zoneTotals = this.getAllCounts(zoneCounts);

        const { movingId, staticId, totalId } = buildOccupancyZoneId({ zoneName });
        this.writeOccupancySensors({ movingId, staticId, totalId }, zoneTotals);
    }

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

    private maybeCleanDetectionInputCache(nowMs = Date.now()) {
        if (nowMs - this.detectionInputCacheLastCleanMs < this.detectionInputCacheCleanIntervalMs)
            return;

        for (const [k, v] of this.detectionInputCache.entries()) {
            if (v.expiresAtMs <= nowMs)
                this.detectionInputCache.delete(k);
        }

        // Best-effort: keep memory bounded.
        if (this.detectionInputCache.size > this.detectionInputCacheMaxEntries) {
            const entries = Array.from(this.detectionInputCache.entries())
                .sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs);
            const toRemove = this.detectionInputCache.size - this.detectionInputCacheMaxEntries;
            for (let i = 0; i < toRemove; i++) {
                const key = entries[i]?.[0];
                if (key)
                    this.detectionInputCache.delete(key);
            }
        }

        this.detectionInputCacheLastCleanMs = nowMs;
    }

    private makeDetectionLogKey(detectionId: any, detection: ObjectDetectionResult, zonesKey: string): string {
        const className = detection?.className ?? '';
        const label = (detection)?.label ?? '';
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
        for (const key of Object.keys(this.storageSettings.settings)) {
            if (key.startsWith(this.zoneSettingPrefix))
                delete this.storageSettings.settings[key];
        }
    }

    private ensureDynamicStorageSetting(key: string, setting: any) {
        this.storageSettings.settings[key] = setting;
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
        this.storageSettings.settings.zones.choices = zoneNames;

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

        // Cleanup old dynamic settings that used to store occupancy counts.
        this.cleanupLegacyActiveObjectSettings();

        const streamOptions = await this.mixinDevice.getVideoStreamOptions();
        const localRecorderFound = streamOptions.find(option => option.destinations.includes('local-recorder'));
        if (localRecorderFound) {
            logger.log('localRecorderFound', JSON.stringify(localRecorderFound));
            this.inputDimensions = [localRecorderFound.video.width, localRecorderFound.video.height];
        }

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
        const nowMs = Date.now();
        this.maybeCleanDetectionInputCache(nowMs);

        const cacheKey = detectionId;
        const cached = this.detectionInputCache.get(cacheKey);
        if (cached && cached.expiresAtMs > nowMs) {
            if (cached.value)
                return cached.value;
            if (cached.inFlight)
                return cached.inFlight;
        }

        const url = `${this.plugin.plugin.storageSettings.values.serverUrl}/events/${detectionId}/snapshot.jpg`;

        const inFlight = (async () => {
            try {
                const jpeg = await axios.get(url, { responseType: "arraybuffer" });
                const mo = await sdk.mediaManager.createMediaObject(jpeg.data, 'image/jpeg');
                logger.info(`Frigate object event ${detectionId} found`);
                return mo;
            } catch (e) {
                logger.info(`Error fetching Frigate object event ${detectionId} ${eventId} from ${url}`, e.message);
                return this.mixinDevice.getDetectionInput(detectionId, eventId);
            }
        })();

        this.detectionInputCache.set(cacheKey, {
            expiresAtMs: nowMs + this.detectionInputCacheTtlMs,
            inFlight,
        });

        try {
            const value = await inFlight;
            const entry = this.detectionInputCache.get(cacheKey);
            if (entry) {
                entry.value = value;
                delete entry.inFlight;
            }
            return value;
        }
        catch (err) {
            this.detectionInputCache.delete(cacheKey);
            throw err;
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

    private convertAndScaleFrigateBox(
        frigateBox: [number, number, number, number] | undefined | null,
        detectWidth: number,
        detectHeight: number,
        realInputDimensions: [number, number] | undefined
    ): ObjectDetectionResult['boundingBox'] | undefined {
        if (!frigateBox || !Array.isArray(frigateBox) || frigateBox.length < 4) {
            return undefined;
        }

        // Frigate boxes from MQTT events are [xMin, yMin, xMax, yMax] in pixels for the detect stream.
        // Convert to Scrypted format [x, y, width, height] in detect pixel coordinates
        const [xMin, yMin, xMax, yMax] = frigateBox;
        const width = xMax - xMin;
        const height = yMax - yMin;

        // Boxes are already in detect pixel coordinates, no need to convert from normalized
        const xDetect = xMin;
        const yDetect = yMin;
        const wDetect = width;
        const hDetect = height;

        // Scale to real inputDimensions if available
        const scaleX = realInputDimensions ? realInputDimensions[0] / detectWidth : 1;
        const scaleY = realInputDimensions ? realInputDimensions[1] / detectHeight : 1;

        let x = Math.round(xDetect * scaleX);
        let y = Math.round(yDetect * scaleY);
        let w = Math.round(wDetect * scaleX);
        let h = Math.round(hDetect * scaleY);

        // Get box extension percentage from settings (default 10%)
        const boxExtensionPercent = parseFloat(this.storageSettings.values.boxExtensionPercent || '10') || 10;
        const extensionFactor = boxExtensionPercent / 100;

        // Extend the box by the configured percentage
        const extensionX = Math.round(w * extensionFactor);
        const extensionY = Math.round(h * extensionFactor);

        // Extend x and y (move top-left corner up and left)
        x = Math.max(0, x - extensionX);
        y = Math.max(0, y - extensionY);

        // Extend width and height (extend bottom-right corner down and right)
        w = w + (2 * extensionX);
        h = h + (2 * extensionY);

        // Ensure the box doesn't exceed image bounds
        const finalInputDimensions: [number, number] = realInputDimensions || [detectWidth, detectHeight];
        const maxX = finalInputDimensions[0];
        const maxY = finalInputDimensions[1];

        // Clamp width and height to not exceed image bounds
        if (x + w > maxX) {
            w = maxX - x;
        }
        if (y + h > maxY) {
            h = maxY - y;
        }

        // Ensure width and height are positive
        w = Math.max(0, w);
        h = Math.max(0, h);

        return [x, y, w, h];
    }

    async onFrigateDetectionEvent(event: FrigateEvent) {
        const { eventTypes, labels, cameraName } = this.storageSettings.values;
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

        // Get camera config for detect dimensions
        const config = await this.plugin.plugin.getConfiguration();
        const cameraConfig = config?.cameras?.[cameraName];
        const detectWidth = cameraConfig?.detect?.width || 3840;
        const detectHeight = cameraConfig?.detect?.height || 2160;

        // Use inputDimensions from init if available
        const realInputDimensions = this.inputDimensions && this.inputDimensions[0] > 0 && this.inputDimensions[1] > 0
            ? this.inputDimensions
            : undefined;

        // Convert and scale Frigate boxes
        const personBox = this.convertAndScaleFrigateBox(
            event.after.box,
            detectWidth,
            detectHeight,
            realInputDimensions
        );

        // Motion box: prefer region (larger area) if available.
        const motionSourceBox = (event.after.region ?? event.after.snapshot?.region ?? event.after.box);
        const motionBox = this.convertAndScaleFrigateBox(
            motionSourceBox,
            detectWidth,
            detectHeight,
            realInputDimensions
        );

        // Face box: prefer Frigate snapshot face attribute box if present.
        const snapshotFace = event.after.snapshot?.attributes?.find(a => a?.label === 'face');
        const faceSourceBox = snapshotFace?.box ?? event.after.box;
        const faceBox = this.convertAndScaleFrigateBox(
            faceSourceBox,
            detectWidth,
            detectHeight,
            realInputDimensions
        );

        const frigateDetections: ObjectDetectionResult[] = [];

        // Always include a motion detection.
        if (motionBox) {
            frigateDetections.push({
                className: 'motion',
                score: 1,
                boundingBox: motionBox,
                zones: event.after.current_zones,
            });
        }

        if (personBox) {
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
        }

        // If this is a person with a recognized sub_label, emit an additional face detection.
        if (eventLabel === 'person' && subLabel && faceBox) {
            frigateDetections.push({
                className: 'face',
                score: subLabelScore ?? 1,
                boundingBox: faceBox,
                label: subLabel,
                labelScore: subLabelScore,
                zones: event.after.current_zones,
            });
        }

        const finalInputDimensions: [number, number] = realInputDimensions || [detectWidth, detectHeight];

        const detection: ObjectsDetected = {
            timestamp,
            detectionId,
            detections: frigateDetections,
            sourceId: pluginId,
            inputDimensions: finalInputDimensions,
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

        if (this.motionDetectedResetTimeout) {
            clearTimeout(this.motionDetectedResetTimeout);
            this.motionDetectedResetTimeout = undefined;
        }

        this.seenDetectionLogKeys.clear();
        this.seenDetectionLogKeysLastCleanMs = Date.now();
        this.detectionInputCache.clear();
        this.detectionInputCacheLastCleanMs = Date.now();
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
