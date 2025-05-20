import axios from 'axios';
import { name } from '../package.json';
import sdk, { ObjectsDetected } from '@scrypted/sdk';

export const FRIGATE_OBJECT_DETECTOR_INTERFACE = `${name}:objectDetector`;
export const FRIGATE_VIDEOCLIPS_INTERFACE = `${name}:videoclips`;

export type FrigateObjectDetection = ObjectsDetected & { frigateEvent: FrigateEvent };

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

interface DetectionData {
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

export const baseFrigateApi = (props: {
    apiUrl: string;
    service: string;
    params?: any;
}) => {
    const { apiUrl, service, params } = props;

    const url = `${apiUrl}/${service}`;
    return axios.get<any>(url.toString(), {
        params
    });
}

export type AudioType = 'dBFS' | 'rms' | string;