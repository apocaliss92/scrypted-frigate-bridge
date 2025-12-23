export type FrigateRole = 'detect' | 'record' | 'audio' | string;

export interface FrigateFfmpegInput {
    path?: string;
    roles?: FrigateRole[];
    global_args?: string[];
    hwaccel_args?: string | string[];
    input_args?: string | string[];
    output_args?: unknown;
    [key: string]: unknown;
}

export interface FrigateFfmpegConfig {
    inputs?: Array<string | FrigateFfmpegInput>;
    global_args?: string[];
    hwaccel_args?: string | string[];
    input_args?: string | string[];
    output_args?: unknown;
    [key: string]: unknown;
}

export interface FrigateZoneConfig {
    coordinates?: string | number[];
    filters?: Record<string, unknown>;
    color?: number[];
    objects?: string[];
    distances?: unknown[];
    inertia?: number;
    loitering_time?: number;
    friendly_name?: string;
    [key: string]: unknown;
}

export interface FrigateCameraConfig {
    name?: string;
    enabled?: boolean;

    ffmpeg?: FrigateFfmpegConfig;

    live?: {
        streams?: Record<string, string> | string[];
        height?: number;
        quality?: number;
        [key: string]: unknown;
    };

    audio?: {
        enabled?: boolean;
        listen?: string[];
        [key: string]: unknown;
    };

    detect?: {
        enabled?: boolean;
        width?: number;
        height?: number;
        fps?: number;
        [key: string]: unknown;
    };

    birdseye?: {
        enabled?: boolean;
        mode?: string;
        order?: number;
        [key: string]: unknown;
    };

    zones?: Record<string, FrigateZoneConfig>;

    objects?: {
        track?: string[];
        filters?: Record<string, unknown>;
        mask?: string;
        [key: string]: unknown;
    };

    record?: {
        enabled?: boolean;
        [key: string]: unknown;
    };

    review?: Record<string, unknown>;
    snapshots?: Record<string, unknown>;
    onvif?: Record<string, unknown>;

    enabled_in_config?: boolean;
    ffmpeg_cmds?: Array<{ roles?: string[]; cmd?: string; [key: string]: unknown }>;

    [key: string]: unknown;
}

export type FrigateGo2RtcStreamDefinition =
    | string
    | string[]
    | Record<string, unknown>
    | Array<string | Record<string, unknown>>;

export interface FrigateConfig {
    version?: string;
    safe_mode?: boolean;

    environment_vars?: Record<string, string>;

    logger?: {
        default?: string;
        logs?: Record<string, unknown>;
        [key: string]: unknown;
    };

    auth?: {
        enabled?: boolean;
        cookie_name?: string;
        cookie_secure?: boolean;
        session_length?: number;
        refresh_time?: number;
        trusted_proxies?: string[];
        roles?: Record<string, unknown>;
        [key: string]: unknown;
    };

    database?: {
        path?: string;
        [key: string]: unknown;
    };

    mqtt?: {
        enabled?: boolean;
        host?: string;
        port?: number;
        topic_prefix?: string;
        client_id?: string;
        stats_interval?: number;
        user?: string;
        password?: string;
        qos?: number;
        [key: string]: unknown;
    };

    go2rtc?: {
        streams?: Record<string, FrigateGo2RtcStreamDefinition>;
        [key: string]: unknown;
    };

    detectors?: Record<string, {
        type?: string;
        model?: Record<string, unknown>;
        [key: string]: unknown;
    }>;

    model?: Record<string, unknown>;
    genai?: Record<string, unknown>;

    cameras?: Record<string, FrigateCameraConfig>;

    birdseye?: Record<string, unknown>;
    audio?: Record<string, unknown>;
    detect?: Record<string, unknown>;
    ffmpeg?: Record<string, unknown>;
    objects?: Record<string, unknown>;
    record?: Record<string, unknown>;
    review?: Record<string, unknown>;
    snapshots?: Record<string, unknown>;
    timestamp_style?: Record<string, unknown>;
    audio_transcription?: Record<string, unknown>;
    classification?: Record<string, unknown>;
    semantic_search?: Record<string, unknown>;
    face_recognition?: Record<string, unknown>;
    lpr?: Record<string, unknown>;
    camera_groups?: Record<string, unknown>;
    plus?: Record<string, unknown>;

    // Forward compatibility: Frigate adds new top-level sections frequently.
    [key: string]: unknown;
}

/** Parsed output of Frigate `/config/raw` (YAML), shape is very close to `/config` but often less enriched. */
export type FrigateRawConfig = FrigateConfig;
