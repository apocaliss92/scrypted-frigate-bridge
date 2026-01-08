import sdk, { ClipPath, Settings, Setting } from '@scrypted/sdk';
import { SettingsMixinDeviceBase } from '@scrypted/sdk/settings-mixin';
import { StorageSetting, StorageSettings, StorageSettingsDevice, StorageSettingsDict } from '@scrypted/sdk/storage-settings';
import axios, { Method } from 'axios';
import { execFile, spawn } from 'child_process';
import { search } from 'fast-fuzzy';
import { keyBy } from 'lodash';
import { promisify } from 'util';
import { name } from '../package.json';
import FrigateBridgePlugin from './main';

export const objectDetectorNativeId = 'frigateObjectDetector';
export const motionDetectorNativeId = 'frigateMotionDetector';
export const audioDetectorNativeId = 'frigateAudioDetector';
export const videoclipsNativeId = 'frigateVideoclips';
export const eventsRecorderNativeId = 'frigateEventsRecorder';
export const birdseyeCameraNativeId = 'frigateBirdseyeCamera';
export const importedCameraNativeIdPrefix = 'frigateCamera';
export const birdseyeStreamName = 'birdseye';

export const buildOccupancyZoneId = (props: {
    zoneName?: string;
    className?: string;
}) => {
    const { zoneName, className } = props;

    let prefix = '';
    if (zoneName)
        prefix += `${zoneName}:`;
    if (className)
        prefix += `${className}:`;


    const movingId = `${name}:${prefix}moving`;
    const staticId = `${name}:${prefix}static`;
    const totalId = `${name}:${prefix}total`;

    return { movingId, staticId, totalId };
}

export type ZoneWithPath = {
    name: string;
    path: ClipPath;
};

export const getFrigateMixinSettings = async (deviceId: string) => {
    const device = sdk.systemManager.getDeviceById<Settings>(deviceId);

    const settings = await device.getSettings();

    const settingsDict = keyBy(settings, 'key');

    const zoneNames = settingsDict[`${objectDetectorNativeId}:zones`]?.value as string[];

    const zones = zoneNames.map(zoneName => {
        const path = settingsDict[`${objectDetectorNativeId}:zone:${zoneName}:path`]?.value as ClipPath;
        return { name: zoneName, path };
    });
    const cameraName = settingsDict[`${objectDetectorNativeId}:cameraName`]?.value as string ||
        settingsDict[`${motionDetectorNativeId}:cameraName`]?.value as string ||
        settingsDict[`${audioDetectorNativeId}:cameraName`]?.value as string ||
        '';
    const audioLabels = settingsDict[`${audioDetectorNativeId}:labels`]?.value as string[] || [];
    const objectLabels = settingsDict[`${objectDetectorNativeId}:labels`]?.value as string[] || [];

    return { zones, cameraName, audioLabels, objectLabels };

};

export const getFrigatePluginSettings = async () => {
    const frigatePlugin = sdk.systemManager.getDeviceByName<Settings>('Frigate bridge');
    const settings = await frigatePlugin.getSettings();
    const settingsDic = keyBy(settings, 'key');
    const objectLabels = (settingsDic['objectLabels']?.value ?? []) as string[];
    const audioLabels = (settingsDic['audioLabels']?.value ?? []) as string[];
    const cameras = settingsDic['cameras']?.value as string[];
    const faces = settingsDic['faces']?.value as string[];

    return { cameras, audioLabels, objectLabels, faces };

};

export const pluginId = name;

export const FRIGATE_OBJECT_DETECTOR_INTERFACE = `${pluginId}:objectDetector`;
export const FRIGATE_MOTION_DETECTOR_INTERFACE = `${pluginId}:motionDetector`;
export const FRIGATE_AUDIO_DETECTOR_INTERFACE = `${pluginId}:audioDetector`;
export const FRIGATE_VIDEOCLIPS_INTERFACE = `${pluginId}:videoclips`;
export const FRIGATE_EVENTS_RECORDER_INTERFACE = `${pluginId}:eventsRecorder`;
export const FRIGATE_SNAPSHOT_INTERFACE = `${pluginId}:snapshot`;

export const motionTopic = `frigate/+/motion`;
export const eventsTopic = `frigate/events`;
export const audioTopic = `frigate/+/audio/+`;
export const audioDetectionsTopic = 'frigate/audio_detections';
export const activeTopicWildcard = 'frigate/+/+/active';
export const objectCountTopicWildcard = 'frigate/+/+';

export const excludedAudioLabels = ['state', 'all'];

interface Snapshot {
    frame_time: number;
    box: [number, number, number, number];
    area: number;
    region: [number, number, number, number];
    score: number;
    attributes: any[]; // Lista vuota o altri attributi se servono più dettagli
}

interface AttributeDetail {
    label: string;
    box: [number, number, number, number];
    score: number;
}

export interface DetectionData {
    id: string;
    camera: string;
    frame_time: number;
    snapshot: Snapshot;
    label: string;
    sub_label: [string, number] | null;
    top_score: number;
    false_positive: boolean;
    start_time: number;
    end_time: number | null;
    score: number;
    box: [number, number, number, number];
    area: number;
    ratio: number;
    region: [number, number, number, number];
    current_zones: string[];
    entered_zones: string[];
    thumbnail: string | null;
    has_snapshot: boolean;
    has_clip: boolean;
    active: boolean;
    stationary: boolean;
    motionless_count: number;
    position_changes: number;
    attributes: Record<string, number>; // esempio: { face: 0.86 }
    current_attributes: AttributeDetail[];
    data?: { type: 'object' | 'audio' }
}

export interface FrigateEvent {
    type: 'new' | 'update' | 'end';
    before: DetectionData;
    after: DetectionData;
}

export interface FrigateVideoClip {
    id: string;
    camera: string;
    label: string;
    zones: string[];
    start_time: number;
    end_time: number;
    has_clip: boolean;
    has_snapshot: boolean;
    plus_id: string | null;
    retain_indefinitely: boolean;
    sub_label: string | null;
    top_score: number | null;
    false_positive: boolean | null;
    box: number[] | null;
    data: {
        box: number[];
        region: number[];
        score: number;
        top_score: number;
        attributes: string[];
        type: 'object';
        max_severity: 'alert' | 'detection'; // se "alert" è l'unico valore possibile, lascialo così
    };
    thumbnail: string; // base64 stringa dell'immagine
}

export const convertFrigateBoxToScryptedBox = (frigateBox: [number, number, number, number]): [number, number, number, number] => {
    const [xMin, yMin, xMax, yMax] = frigateBox;
    const width = xMax - xMin;
    const height = yMax - yMin;
    return [xMin, yMin, width, height];
}

export type Point2D = [number, number];

export type FrigatePolygonInput = string | number[];

export type ScryptedPolygonOptions = {
    /**
     * If true, treat the input values as 0..100 instead of 0..1.
     * If omitted, it will be auto-detected.
     */
    inputIsPercent?: boolean;
    /** Output coordinates are 0..100 by default. */
    outputScale?: number;
    /** Swap X and Y axes. */
    swapXY?: boolean;
    /** Invert Y axis (y -> 1 - y) before scaling. */
    invertY?: boolean;
    /** Clamp points to the target range (defaults to true). */
    clamp?: boolean;
    /** Round to N decimals (omit to keep full precision). */
    decimals?: number;
    /** Close the polygon by appending the first point at the end. */
    close?: boolean;
    /**
     * Optional mapping from source aspect ratio (camera frame) to target aspect ratio
     * (UI/canvas) when the preview uses CSS-like object-fit semantics.
     */
    objectFit?: 'none' | 'contain' | 'cover';
    /** Source aspect ratio = width/height (e.g. 16/9, 4/3, 9/16). */
    sourceAspectRatio?: number;
    /** Target aspect ratio = width/height (defaults to 1 i.e. square). */
    targetAspectRatio?: number;
};

const roundTo = (value: number, decimals: number | undefined) => {
    if (decimals === undefined)
        return value;
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const mapWithObjectFit = (point: Point2D, options: Required<Pick<ScryptedPolygonOptions, 'objectFit' | 'sourceAspectRatio' | 'targetAspectRatio'>> & { clamp: boolean }): Point2D => {
    const [x, y] = point;
    const { objectFit, sourceAspectRatio, targetAspectRatio } = options;

    if (objectFit === 'none')
        return options.clamp ? [clamp01(x), clamp01(y)] : [x, y];

    // Work in a normalized coordinate space with explicit aspect ratios.
    // Source size: [sourceAR, 1], Target size: [targetAR, 1]
    const srcW = sourceAspectRatio;
    const srcH = 1;
    const dstW = targetAspectRatio;
    const dstH = 1;

    const scale = objectFit === 'contain'
        ? Math.min(dstW / srcW, dstH / srcH)
        : Math.max(dstW / srcW, dstH / srcH);

    const scaledW = srcW * scale;
    const scaledH = srcH * scale;

    const offsetX = (dstW - scaledW) / 2;
    const offsetY = (dstH - scaledH) / 2;

    const px = x * srcW;
    const py = y * srcH;

    const mappedX = (px * scale + offsetX) / dstW;
    const mappedY = (py * scale + offsetY) / dstH;

    if (options.clamp)
        return [clamp01(mappedX), clamp01(mappedY)];

    return [mappedX, mappedY];
}

/**
 * Parses Frigate polygon coordinates.
 *
 * Frigate commonly represents polygons as `x1,y1,x2,y2,...` where x/y are normalized (0..1).
 */
export const parseFrigatePolygonCoordinates = (input: FrigatePolygonInput): Point2D[] => {
    const values = (typeof input === 'string')
        ? input
            .split(/[^0-9eE+\-\.]+/)
            .filter(Boolean)
            .map(v => Number.parseFloat(v))
        : input.map(v => Number(v));

    const clean = values.filter(v => Number.isFinite(v));
    if (clean.length < 6 || clean.length % 2 !== 0) {
        throw new Error(`Invalid Frigate polygon coordinate list: expected an even count >= 6, got ${clean.length}`);
    }

    const points: Point2D[] = [];
    for (let i = 0; i < clean.length; i += 2) {
        points.push([clean[i], clean[i + 1]]);
    }

    return points;
}

/**
 * Converts a Frigate polygon (0..1 or 0..100) into a Scrypted polygon in 0..outputScale (default 100).
 */
export const convertFrigatePolygonToScryptedPolygon = (
    points: Point2D[],
    options: ScryptedPolygonOptions = {},
): Point2D[] => {
    const {
        inputIsPercent,
        outputScale = 100,
        swapXY = false,
        invertY = false,
        clamp = true,
        decimals,
        close = false,
        objectFit = 'none',
        sourceAspectRatio = 1,
        targetAspectRatio = 1,
    } = options;

    // Heuristic: if any value is > 1.5 assume percent.
    const autoIsPercent = points.some(([x, y]) => Math.max(x, y) > 1.5);
    const isPercent = inputIsPercent ?? autoIsPercent;

    const mapped = points.map(([rawX, rawY]) => {
        let x = isPercent ? rawX / 100 : rawX;
        let y = isPercent ? rawY / 100 : rawY;

        if (swapXY)
            [x, y] = [y, x];

        if (invertY)
            y = 1 - y;

        const [fitX, fitY] = mapWithObjectFit([x, y], {
            objectFit,
            sourceAspectRatio,
            targetAspectRatio,
            clamp,
        });

        const outX = roundTo(fitX * outputScale, decimals);
        const outY = roundTo(fitY * outputScale, decimals);
        return [outX, outY] as Point2D;
    });

    if (close && mapped.length) {
        const first = mapped[0];
        const last = mapped[mapped.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1])
            mapped.push([first[0], first[1]]);
    }

    return mapped;
}

/** Convenience: parse + convert. */
export const convertFrigatePolygonCoordinatesToScryptedPolygon = (input: FrigatePolygonInput, options: ScryptedPolygonOptions = {}) => {
    const points = parseFrigatePolygonCoordinates(input);
    return convertFrigatePolygonToScryptedPolygon(points, options);
}

/** Formats points as a JSON string that can be pasted into Scrypted settings. */
export const formatScryptedPolygonJson = (points: Point2D[]) => JSON.stringify(points);

/**
 * Converts points (typically 0..100) into an SVG path string compatible with Scrypted region/mask inputs.
 * Example: [[10,20],[30,40]] -> "M 10 20 L 30 40 Z"
 */
export const pointsToScryptedSvgPath = (points: Point2D[], options?: { close?: boolean }) => {
    const close = options?.close ?? true;
    if (!points?.length)
        return '';

    const [firstX, firstY] = points[0];
    const segments = [`M ${firstX} ${firstY}`];

    for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        segments.push(`L ${x} ${y}`);
    }

    if (close)
        segments.push('Z');

    return segments.join(' ');
}

export const baseFrigateApi = <T = any>(props: {
    apiUrl: string;
    service: string;
    params?: any;
    body?: any;
    method?: Method;
}) => {
    const { apiUrl, service, params, body, method = 'GET' } = props;

    const url = `${apiUrl}/${service}`;
    return axios.request<T>({
        method,
        url: url.toString(),
        params,
        data: body
    })
}

export const parseFraction = (value: unknown): number | undefined => {
    if (typeof value !== 'string' || !value)
        return undefined;
    const [a, b] = value.split('/');
    const num = Number.parseFloat(a);
    const den = Number.parseFloat(b);
    if (!Number.isFinite(num))
        return undefined;
    if (!Number.isFinite(den) || den === 0)
        return num;
    return num / den;
}

export const toArray = <T>(value: unknown): T[] => Array.isArray(value) ? (value as T[]) : [];

export const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> => {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= items.length)
                return;
            results[current] = await fn(items[current], current);
        }
    });

    await Promise.all(workers);
    return results;
}

export const sanitizeCameraInputUrl = (inputUrl: string): string => {
    const trimmed = (inputUrl ?? '').trim();
    if (!trimmed)
        return trimmed;

    // Remove query/hash (often transport/options) and credentials.
    const noQuery = trimmed.split('#')[0].split('?')[0];

    try {
        const u = new URL(noQuery);
        u.username = '';
        u.password = '';
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        // Fallback for rtsp-like URLs that may not parse cleanly.
        return noQuery.replace(/^(rtsp[s]?:\/\/)([^@/]+@)/i, '$1');
    }
}

export const ffprobeLocalJson = async (url: string, options?: {
    timeoutMs?: number;
}): Promise<{ streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> } & Record<string, unknown>> => {
    const timeoutMs = options?.timeoutMs ?? 15000;

    const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        url,
    ];

    const fallbackPath = [
        process.env.PATH,
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
    ].filter(Boolean).join(':');

    const runSpawn = () => new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
        const child = spawn('ffprobe', args, {
            env: {
                ...process.env,
                PATH: fallbackPath,
            },
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
            }
        }, timeoutMs);

        child.stdout?.on('data', d => stdout += d.toString());
        child.stderr?.on('data', d => stderr += d.toString());
        child.on('error', err => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code });
        });
    });

    const errors: string[] = [];

    try {
        const { stdout, stderr, exitCode } = await runSpawn();
        if (exitCode !== 0) {
            errors.push(`ffprobe exited with ${exitCode}${stderr?.trim() ? `: ${stderr.trim()}` : ''}`);
        } else {
            const parsed = JSON.parse(stdout || '{}');
            return (parsed && typeof parsed === 'object') ? parsed : {};
        }
    } catch (e) {
        const message = (e instanceof Error) ? e.message : String(e);
        errors.push(`ffprobe spawn failed: ${message}`);
    }

    // Last resort: try execFile with PATH fallback, in case spawn is restricted.
    try {
        const execFileAsync = promisify(execFile);
        const { stdout, stderr } = await execFileAsync('ffprobe', args, {
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                PATH: fallbackPath,
            },
        });
        const parsed = JSON.parse(stdout || '{}');
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        const message = (e instanceof Error) ? e.message : String(e);
        errors.push(`execFile(ffprobe) failed: ${message}`);
    }

    throw new Error(`Local ffprobe failed for ${url}. Attempts: ${errors.join(' | ')}`);
}

export type AudioType = 'dBFS' | 'rms' | string;

export const isAudioLevelValue = (eventType: AudioType) => ['dBFS', 'rms'].includes(eventType);

export const toSnakeCase = (str: string) => str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();

const normalizeNameForMatch = (value: string) => {
    if (!value)
        return '';

    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[_\-]+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const normalizeForCameraGuess = (value: string) => {
    const normalized = normalizeNameForMatch(value);
    if (!normalized)
        return '';

    const stopwords = new Set([
        'camera',
        'cam',
        'videocamera',
        'ipcam',
        'ipc',
        'onvif',
    ]);

    return normalized
        .split(' ')
        .map(t => t.trim())
        .filter(t => t && !stopwords.has(t))
        .join(' ')
        .trim();
}

/**
 * Tries to guess the best matching camera name from a list, based on a Scrypted device name.
 * Example: deviceName="videocamera salone", candidates=["camera_salone","camera_cucina"] => "camera_salone".
 */
export const guessBestCameraName = (deviceName: string, cameraNames: string[]) => {
    if (!deviceName?.trim() || !cameraNames?.length)
        return undefined;

    const term = normalizeForCameraGuess(deviceName);
    if (!term)
        return undefined;

    const candidates = cameraNames.map(name => ({ name, key: normalizeForCameraGuess(name) }));

    const results = search(term, candidates, {
        keySelector: c => c.key,
        returnMatchData: true,
        threshold: 0.2,
    });

    return results[0]?.item?.name;
}

export const initFrigateMixin = async (props: {
    mixin: SettingsMixinDeviceBase<any>,
    storageSettings: StorageSettings<any>,
    plugin: FrigateBridgePlugin,
    logger: Console,
}) => {
    const { mixin, storageSettings, plugin, logger } = props;
    storageSettings.settings.cameraName.choices = plugin.storageSettings.values.cameras;
    if (mixin.pluginId === pluginId) {
        const [_, cameraName] = mixin.nativeId.split('__');
        storageSettings.values.cameraName = cameraName;
        storageSettings.settings.cameraName.readonly = true;
    }

    if (!storageSettings.values.cameraName) {
        const bestGuess = guessBestCameraName(mixin.name, plugin.storageSettings.values.cameras);
        if (bestGuess) {
            logger.log(`Guessed camera name "${bestGuess}" for device "${mixin.name}"`);
            storageSettings.values.cameraName = bestGuess;
        }
    }
}

export const ensureMixinsOrder = (props: {
    mixin: SettingsMixinDeviceBase<any>,
    plugin: FrigateBridgePlugin,
    logger: Console,
}) => {
    const { mixin, logger, plugin } = props;
    const nvrObjectDetector = sdk.systemManager.getDeviceById('@scrypted/nvr', 'detection')?.id;
    const basicObjectDetector = sdk.systemManager.getDeviceById('@apocaliss92/scrypted-basic-object-detector')?.id;
    let shouldBeMoved = false;
    const thisMixinOrder = mixin.mixins.indexOf(plugin.id);

    if (nvrObjectDetector && mixin.mixins.indexOf(nvrObjectDetector) > thisMixinOrder) {
        shouldBeMoved = true
    }
    if (basicObjectDetector && mixin.mixins.indexOf(basicObjectDetector) > thisMixinOrder) {
        shouldBeMoved = true
    }

    if (shouldBeMoved) {
        logger.log('This plugin needs other object detection plugins to come before, fixing');
        setTimeout(() => {
            const currentMixins = mixin.mixins.filter(m => m !== plugin.id);
            currentMixins.push(plugin.id);
            const thisDevice = sdk.systemManager.getDeviceById(mixin.id);
            thisDevice.setMixins(currentMixins);
        }, 1000);
    }
}

export const parseActivePayload = (payload: any): boolean | undefined => {
    const raw = (typeof payload === 'string' ? payload : payload?.toString?.())?.trim();
    if (!raw)
        return undefined;

    // Common MQTT representations.
    const lower = raw.toLowerCase();
    if (['1', 'true', 'on', 'yes', 'open', 'active'].includes(lower))
        return true;
    if (['0', 'false', 'off', 'no', 'closed', 'inactive'].includes(lower))
        return false;

    // JSON payloads (best-effort).
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'boolean')
            return parsed;
        if (typeof parsed?.active === 'boolean')
            return parsed.active;
        if (typeof parsed?.state === 'boolean')
            return parsed.state;
        if (typeof parsed?.value === 'boolean')
            return parsed.value;
    } catch {
    }

    return undefined;
}

export const parseMqttCountPayload = (payload: any): number | undefined => {
    const raw = (typeof payload === 'string' ? payload : payload?.toString?.())?.trim();
    if (!raw)
        return undefined;

    // Many Frigate count topics publish plain integers.
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber))
        return Math.trunc(asNumber);

    // Best-effort JSON.
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'number' && Number.isFinite(parsed))
            return Math.trunc(parsed);
        if (typeof parsed?.value === 'number' && Number.isFinite(parsed.value))
            return Math.trunc(parsed.value);
    } catch {
    }

    return undefined;
}

export const convertSettingsToStorageSettings = async (props: {
    device: StorageSettingsDevice,
    dynamicSettings: StorageSetting[],
    initStorage: StorageSettingsDict<string>,
}) => {
    const { device, dynamicSettings, initStorage } = props;

    const onPutToRestore: Record<string, any> = {};
    Object.entries(initStorage).forEach(([key, setting]) => {
        if (setting.onPut) {
            onPutToRestore[key] = setting.onPut;
        }
    });

    const settings: StorageSetting[] = await new StorageSettings(device, initStorage).getSettings();

    settings.push(...dynamicSettings);

    const deviceSettings: StorageSettingsDict<string> = {};

    for (const setting of settings) {
        const { value, key, onPut, ...rest } = setting;
        deviceSettings[key] = {
            ...rest,
            value: rest.type === 'html' ? value : undefined
        };
        if (setting.onPut) {
            deviceSettings[key].onPut = setting.onPut.bind(device)
        }
    }

    const updateStorageSettings = new StorageSettings(device, deviceSettings);

    Object.entries(onPutToRestore).forEach(([key, onPut]) => {
        if (updateStorageSettings.settings[key]) {
            updateStorageSettings.settings[key].onPut = onPut;
        }
    });

    return updateStorageSettings;
}