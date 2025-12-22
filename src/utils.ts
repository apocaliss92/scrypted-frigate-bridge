import sdk, { ObjectsDetected, ScryptedDevice } from '@scrypted/sdk';
import axios, { Method } from 'axios';
import { search } from 'fast-fuzzy';
import { name } from '../package.json';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import FrigateBridgePlugin from './main';
import { SettingsMixinDeviceBase } from '@scrypted/sdk/settings-mixin';

export const objectDetectorNativeId = 'frigateObjectDetector';
export const motionDetectorNativeId = 'frigateMotionDetector';
export const audioDetectorNativeId = 'frigateAudioDetector';
export const videoclipsNativeId = 'frigateVideoclips';
export const birdseyeCameraNativeId = 'frigateBirdseyeCamera';
export const importedCameraNativeIdPrefix = 'frigateCamera';
export const birdseyeStreamName = 'birdseye';

export const pluginId = name;

export const FRIGATE_OBJECT_DETECTOR_INTERFACE = `${pluginId}:objectDetector`;
export const FRIGATE_MOTION_DETECTOR_INTERFACE = `${pluginId}:motionDetector`;
export const FRIGATE_AUDIO_DETECTOR_INTERFACE = `${pluginId}:audioDetector`;
export const FRIGATE_VIDEOCLIPS_INTERFACE = `${pluginId}:videoclips`;
export const FRIGATE_SNAPSHOT_INTERFACE = `${pluginId}:snapshot`;

export type FrigateObjectDetection = ObjectsDetected & { frigateEvent: ObjectsDetected };

export const motionTopic = `frigate/+/motion`;
export const eventsTopic = `frigate/events`;
export const audioTopic = `frigate/+/audio/+`;
export const audioDetectionsTopic = 'frigate/audio_detections';
export const activeTopicWildcard = 'frigate/+/+/active';
export const objectCountTopicWildcard = 'frigate/+/+';

export const excludedAudioLabels = ['state', 'all'];

export enum StreamSource {
    Input = 'Input',
    Go2rtc = 'go2rtc',
}

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