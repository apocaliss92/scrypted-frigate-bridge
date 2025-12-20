import sdk, { ObjectsDetected, ScryptedDevice } from '@scrypted/sdk';
import axios, { Method } from 'axios';
import { search } from 'fast-fuzzy';
import { name } from '../package.json';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import FrigateBridgePlugin from './main';
import { SettingsMixinDeviceBase } from '@scrypted/sdk/settings-mixin';

export const objectDetectorNativeId = 'frigateObjectDetector';
export const animalClassifierNativeId = 'frigateAnimalClassifier';
export const vehicleClassifierNativeId = 'frigateVehicleClassifier';
export const motionDetectorNativeId = 'frigateMotionDetector';
export const audioDetectorNativeId = 'frigateAudioDetector';
export const videoclipsNativeId = 'frigateVideoclips';
export const snapshotNativeId = 'frigateSnapshot';
export const birdseyeCameraNativeId = 'frigateBirdseyeCamera';
export const importedCameraNativeIdPrefix = 'frigateCamera';
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
        const [_, cameraName] = mixin.nativeId.split('_');
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