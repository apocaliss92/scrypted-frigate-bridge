import sdk, { MediaObject, PictureOptions, Setting, SettingValue } from "@scrypted/sdk";
import { StorageSetting, StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import { UrlMediaStreamOptions } from '../../scrypted/plugins/ffmpeg-camera/src/common';
import { Destroyable, RtspSmartCamera, createRtspMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import FrigateBridgePlugin from "./main";
import { audioDetectorNativeId, baseFrigateApi, birdseyeStreamName, convertSettingsToStorageSettings, ffprobeLocalJson, mapLimit, motionDetectorNativeId, objectDetectorNativeId, parseFraction, toArray, videoclipsNativeId } from "./utils";

type FfprobeSummary = {
    url: string;
    protocol?: string;
    format?: {
        format_name?: string;
        format_long_name?: string;
        duration?: number;
        bit_rate?: number;
    };
    video?: {
        codec?: string;
        width?: number;
        height?: number;
        fps?: number;
        pix_fmt?: string;
        profile?: string;
        level?: number;
    };
    audio?: {
        codec?: string;
        channels?: number;
        sample_rate?: number;
        bit_rate?: number;
    };
};

export type ConfiguredStreamProbe = {
    cameraName?: string;
    streamName: string;
    streamId: string;
    source: 'go2rtc' | 'input';
    url: string;
    roles?: string[];
    probedAt: number;
    ffprobe?: FfprobeSummary;
    error?: string;
};

type CameraSettingKey =
    | 'logLevel'
    | 'cameraName'
    | 'rerunFfprobe'
    | 'probedStreams'
    | 'nativeMixinsAdded';

class FrigateBridgeCamera extends RtspSmartCamera {
    initStorage: StorageSettingsDict<CameraSettingKey> = {
        logLevel: {
            ...logLevelSetting,
        },
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            readonly: true,
            hide: true,
        },
        rerunFfprobe: {
            title: 'Re-run ffprobe',
            description: 'Re-probe the configured streams via Frigate /api/ffprobe and refresh detected stream URLs/metadata.',
            type: 'button',
            immediate: true,
            hide: true,
            onPut: async () => {
                await this.discoverBestConfiguredStreamUrlsAndProbe({
                    force: true,
                    concurrency: 2,
                });

                // Ensure next stream option fetch recomputes.
                this.videoStreamOptions = undefined;
            },
        },
        probedStreams: {
            json: true,
            hide: true,
        },
        nativeMixinsAdded: {
            type: 'boolean',
            hide: true
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    logger: Console;
    isBirdseyeCamera = false;

    constructor(
        nativeId: string,
        public provider: FrigateBridgePlugin,
        public cameraName: string,
    ) {
        super(nativeId, provider);
        const logger = this.getLogger();

        this.isBirdseyeCamera = this.cameraName === birdseyeStreamName;

        this.init().catch(logger.log);
    }

    private getDetectedStreamKey(streamId: string) {
        return `detectedStream:${streamId}:url`;
    }

    private getStoredProbedStreams(): ConfiguredStreamProbe[] {
        const raw = this.storage.getItem('probedStreams') as any;
        const data = (typeof raw === 'string')
            ? (() => {
                try {
                    return JSON.parse(raw);
                } catch {
                    return undefined;
                }
            })()
            : raw;

        if (!Array.isArray(data))
            return [];
        return data as ConfiguredStreamProbe[];
    }

    private storeProbedStreams(streams: ConfiguredStreamProbe[]) {
        this.storage.setItem('probedStreams', JSON.stringify(streams));
    }

    private getGo2RtcUrlForStreamName(streamName: string): string | undefined {
        if (!streamName)
            return undefined;

        try {
            const base = this.provider?.storageSettings?.values?.baseGo2rtcUrl;
            if (!base)
                return undefined;
            const baseUrl = String(base).replace(/\/+$/, '');
            return `${baseUrl}/${streamName}`;
        } catch {
            return undefined;
        }
    }

    private getBaseGo2rtcUrl(): string | undefined {
        // Prefer explicit user setting.
        const explicit = this.provider?.storageSettings?.values?.baseGo2rtcUrl;
        if (explicit)
            return String(explicit);

        // Fall back to derived default value (set in provider initData).
        const derived = this.provider?.storageSettings?.settings?.baseGo2rtcUrl?.defaultValue as string | undefined;
        if (derived)
            return derived;

        // Last resort: derive from Frigate api url hostname.
        try {
            const host = new URL(this.provider.storageSettings.values.serverUrl).hostname;
            return `rtsp://${host}:8554`;
        } catch {
            return undefined;
        }
    }

    private async ffprobeViaFrigate(url: string): Promise<FfprobeSummary> {
        const res = await baseFrigateApi<any>({
            apiUrl: this.provider.storageSettings.values.serverUrl,
            service: 'ffprobe',
            params: {
                paths: url,
            },
        });

        let data = res?.data;
        // If Frigate reports a failure, attempt local ffprobe as a fallback.
        if (Array.isArray(data)) {
            const first = data[0] as any;
            const returnCode = Number(first?.return_code);
            if (Number.isFinite(returnCode) && returnCode === 1) {
                try {
                    data = await ffprobeLocalJson(url);
                } catch (e) {
                    this.console.log(JSON.stringify(e));
                    const message = (e instanceof Error) ? e.message : String(e);
                    const frigateStderr = (typeof first?.stderr === 'string' && first.stderr.trim()) ? first.stderr.trim() : undefined;
                    throw new Error(`Frigate ffprobe failed (return_code=1) for ${url}${frigateStderr ? `: ${frigateStderr}` : ''}. Local ffprobe fallback failed: ${message}`);
                }
            }
        }
        const parsed = (() => {
            if (!data)
                return {};

            // Common Frigate response: [{ return_code, stdout: { streams, format, ... } }]
            if (Array.isArray(data)) {
                const first = data[0] as any;
                if (first?.stdout && (first.stdout.streams || first.stdout.format))
                    return first.stdout;
                if (first?.streams || first?.format)
                    return first;
            }

            // Some versions return { stdout: { streams, format } }
            if (data.stdout && (data.stdout.streams || data.stdout.format))
                return data.stdout;

            // Or directly { streams, format }
            if (data.streams || data.format)
                return data;

            // Or wrapped in { result: { ... } }
            if (data.result && (data.result.streams || data.result.format || data.result.stdout))
                return data.result.stdout ?? data.result;

            // Or keyed by url: { [url]: { stdout: { ... } } }
            if (typeof data === 'object' && data[url]) {
                const entry = (data as any)[url];
                if (entry?.stdout && (entry.stdout.streams || entry.stdout.format))
                    return entry.stdout;
                if (entry?.streams || entry?.format)
                    return entry;
                if (entry?.result)
                    return entry.result.stdout ?? entry.result;
            }

            // Fall back: first object value.
            if (typeof data === 'object') {
                const first = Object.values(data)[0] as any;
                if (first?.stdout && (first.stdout.streams || first.stdout.format))
                    return first.stdout;
                if (first?.streams || first?.format)
                    return first;
                if (first?.result)
                    return first.result.stdout ?? first.result;
            }

            return {};
        })() as {
            streams?: Array<Record<string, unknown>>;
            format?: Record<string, unknown>;
        };

        const streams = toArray<Record<string, unknown>>(parsed.streams);
        // Some Frigate/ffprobe outputs omit codec_type; infer from width/height.
        const video = streams.find(s => s.codec_type === 'video' || (typeof s.width === 'number' && typeof s.height === 'number'));
        const audio = streams.find(s => s.codec_type === 'audio' || (
            !('width' in s) && !('height' in s)
        ));

        const duration = Number.parseFloat(String(parsed.format?.duration ?? ''));
        const bitRate = Number.parseInt(String(parsed.format?.bit_rate ?? ''), 10);

        const videoWidth = Number.parseInt(String(video?.width ?? ''), 10);
        const videoHeight = Number.parseInt(String(video?.height ?? ''), 10);
        const fps = parseFraction(video?.avg_frame_rate) ?? parseFraction(video?.r_frame_rate);

        const audioSampleRate = Number.parseInt(String(audio?.sample_rate ?? ''), 10);
        const audioChannels = Number.parseInt(String(audio?.channels ?? ''), 10);
        const audioBitRate = Number.parseInt(String(audio?.bit_rate ?? ''), 10);

        const protocol = (() => {
            try {
                const p = new URL(url).protocol;
                return p ? p.replace(/:$/, '') : undefined;
            } catch {
                const m = String(url ?? '').match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
                return m?.[1];
            }
        })();

        return {
            url,
            protocol,
            format: {
                format_name: typeof parsed.format?.format_name === 'string' ? parsed.format.format_name : undefined,
                format_long_name: typeof (parsed.format as any)?.format_long_name === 'string' ? String((parsed.format as any).format_long_name) : undefined,
                duration: Number.isFinite(duration) ? duration : undefined,
                bit_rate: Number.isFinite(bitRate) ? bitRate : undefined,
            },
            video: {
                codec: (typeof video?.codec_name === 'string')
                    ? (video.codec_name as string)
                    : (typeof (video as any)?.codec_long_name === 'string' ? String((video as any).codec_long_name) : undefined),
                width: Number.isFinite(videoWidth) ? videoWidth : undefined,
                height: Number.isFinite(videoHeight) ? videoHeight : undefined,
                fps: Number.isFinite(fps as number) ? (fps as number) : undefined,
                pix_fmt: typeof video?.pix_fmt === 'string' ? (video.pix_fmt as string) : undefined,
                profile: typeof video?.profile === 'string' ? (video.profile as string) : undefined,
                level: typeof video?.level === 'number' ? (video.level as number) : undefined,
            },
            audio: {
                codec: (typeof audio?.codec_name === 'string')
                    ? (audio.codec_name as string)
                    : (typeof (audio as any)?.codec_long_name === 'string' ? String((audio as any).codec_long_name) : undefined),
                channels: Number.isFinite(audioChannels) ? audioChannels : undefined,
                sample_rate: Number.isFinite(audioSampleRate) ? audioSampleRate : undefined,
                bit_rate: Number.isFinite(audioBitRate) ? audioBitRate : undefined,
            },
        };
    }

    async discoverBestConfiguredStreamUrlsAndProbe(options?: {
        force?: boolean;
        concurrency?: number;
    }): Promise<ConfiguredStreamProbe[]> {
        const logger = this.getLogger();
        const now = Date.now();

        const raw = await this.provider.getConfigurationRawJson();
        const config = await this.provider.getConfiguration(options?.force);

        const baseGo2rtcUrl = this.getBaseGo2rtcUrl()?.replace(/\/+$/, '');
        const go2rtcStreams = raw?.go2rtc?.streams ?? config?.go2rtc?.streams ?? {};
        const go2rtcStreamNames = Object.keys(go2rtcStreams ?? {});

        const cameraConfig = (raw?.cameras?.[this.cameraName] ?? config?.cameras?.[this.cameraName]);
        const configuredStreams: ConfiguredStreamProbe[] = [];

        logger.info(JSON.stringify({
            cameraConfig,
            go2rtcStreams,
            raw,
        }));

        const inputs = cameraConfig?.ffmpeg?.inputs;

        inputs.forEach((input, index) => {
            let streamName = `Stream ${index + 1}`;
            const streamId = `stream_${index + 1}`;
            const path = (typeof input === 'string') ? input : (typeof input?.path === 'string' ? input.path : undefined);

            if (path) {
                let isUsingGo2Rtc = false;
                if (go2rtcStreamNames?.length) {
                    isUsingGo2Rtc = go2rtcStreamNames.some(g2rtcStreamName => {

                        if (path.includes(`/${g2rtcStreamName}`) || path.includes(`:${g2rtcStreamName}`)) {
                            streamName = g2rtcStreamName;
                            return true;
                        }
                    });
                }
                let url = path;

                if (isUsingGo2Rtc) {
                    url = `${baseGo2rtcUrl}/${streamName}`;
                    configuredStreams.push({
                        cameraName: this.cameraName,
                        streamName,
                        streamId,
                        source: 'go2rtc',
                        url,
                        probedAt: now,
                    });
                } else {
                    configuredStreams.push({
                        cameraName: this.cameraName,
                        streamName,
                        streamId,
                        source: 'input',
                        url,
                        probedAt: now,
                    });
                }

                const urlKey = this.getDetectedStreamKey(streamId);
                this.storage.setItem(urlKey, url);
            }
        });

        const concurrency = options?.concurrency ?? 4;
        const ffprobeResult = await mapLimit(configuredStreams, concurrency, async (item) => {
            try {
                item.ffprobe = await this.ffprobeViaFrigate(item.url);
            } catch (e) {
                const message = (e instanceof Error) ? e.message : String(e);
                item.error = message;
                logger.debug(`ffprobe failed for ${item.url}: ${message}`);
            }
            return item;
        });

        this.storeProbedStreams(ffprobeResult);

        logger.log(`Discovered and probed ${ffprobeResult.length} configured streams for camera ${this.cameraName}: ${JSON.stringify({
            configuredStreams,
            ffprobeResult
        })}`);

        await this.refreshSettings();

        return ffprobeResult;
    }

    private getStreamsSettings() {
        const settings: StorageSetting[] = [];
        if (this.isBirdseyeCamera) {
            return settings;
        }

        const streams = this.getStoredProbedStreams();

        streams.forEach((stream) => {
            const { streamName, streamId, url } = stream

            const urlKey = this.getDetectedStreamKey(streamId);

            settings.push({
                key: urlKey,
                title: 'URL',
                type: 'string',
                subgroup: streamName,
                defaultValue: url,
                onPut: async () => {
                    this.videoStreamOptions = undefined;
                }
            })
        });

        return settings;
    }

    async refreshSettings() {
        const dynamicSettings: StorageSetting[] = [];

        const streamsSettings = this.getStreamsSettings();
        dynamicSettings.push(...streamsSettings);

        this.storageSettings = await convertSettingsToStorageSettings({
            device: this,
            dynamicSettings,
            initStorage: this.initStorage
        });

        if (this.storageSettings.settings.rerunFfprobe) {
            this.storageSettings.settings.rerunFfprobe.hide = this.isBirdseyeCamera;
        }
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

    async init() {
        const logger = this.getLogger();

        if (!this.isBirdseyeCamera) {
            this.storageSettings.settings.rerunFfprobe.hide = false;
            const existing = this.getStoredProbedStreams();
            if (!existing.length) {
                try {
                    await this.discoverBestConfiguredStreamUrlsAndProbe({
                        concurrency: 2,
                    });
                } catch (e) {
                    logger.debug(`Initial probe failed for camera ${this.cameraName}`, e);
                }
            }

            const listener = sdk.systemManager.listen(async (eventSource, eventDetails, eventData) => {
                if (this.mixins.length === 4 && !this.storageSettings.values.nativeMixinsAdded) {
                    this.storageSettings.values.nativeMixinsAdded = true;
                    const currentMixins = this.mixins;

                    const objectDetector = sdk.systemManager.getDeviceById(this.pluginId, objectDetectorNativeId)?.id;
                    const audioDetector = sdk.systemManager.getDeviceById(this.pluginId, audioDetectorNativeId)?.id;
                    const motionDetector = sdk.systemManager.getDeviceById(this.pluginId, motionDetectorNativeId)?.id;
                    const videoclipsDevice = sdk.systemManager.getDeviceById(this.pluginId, videoclipsNativeId)?.id;

                    const mixinsToAdd = [
                        ...(objectDetector ? [objectDetector] : []),
                        ...(audioDetector ? [audioDetector] : []),
                        ...(motionDetector ? [motionDetector] : []),
                        ...(videoclipsDevice ? [videoclipsDevice] : []),
                    ]

                    const newMixins = [
                        ...currentMixins,
                        ...mixinsToAdd,
                    ];
                    const plugins = await sdk.systemManager.getComponent('plugins');;
                    await plugins.setMixins(this.id, newMixins);

                    logger.log(`Added frigate mixins to camera ${this.storageSettings.values.cameraName}:`, mixinsToAdd);

                    await sdk.deviceManager.requestRestart();
                }

                if (this.mixins.length > 4) {
                    listener?.removeListener();
                }
            });
        }

        await this.refreshSettings();
    }

    getSnapshotUrl(): string {
        const { serverUrl } = this.provider.storageSettings.values;
        const cameraName = this.storage.getItem('cameraName');
        return `${serverUrl}/${cameraName}/latest.jpg`;
    }

    async takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject> {
        const imageUrl = `${this.getSnapshotUrl()}?ts=${Date.now()}`;
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch snapshot: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return sdk.mediaManager.createMediaObject(buffer, 'image/jpeg');
    }

    async listenEvents(): Promise<Destroyable> {
        return null;
    }

    async listenLoop(): Promise<void> {
        return null;
    }

    createRtspMediaStreamOptions(url: string, index: number) {
        const ret = createRtspMediaStreamOptions(url, index);
        ret.tool = 'scrypted';
        return ret;
    }

    async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        const streams: UrlMediaStreamOptions[] = [];

        if (this.isBirdseyeCamera) {
            const url = this.getGo2RtcUrlForStreamName('birdseye');
            if (url) {
                streams.push({
                    name: 'Birdseye',
                    id: 'birdseye',
                    container: 'rtsp',
                    url,
                    // destinations: this.getDetectedStreamsSettingsChoices(),
                });
            }
        } else {
            const probed = this.getStoredProbedStreams();

            probed.forEach((item) => {
                // const isHigh = item.roles?.includes('record')
                //     ?? ((item.ffprobe?.video?.width ?? 0) >= 1280);
                // const destinations: MediaStreamDestination[] = isHigh
                //     ? (['local', 'local-recorder', 'medium-resolution'] as MediaStreamDestination[])
                //     : (['low-resolution', 'remote', 'remote-recorder'] as MediaStreamDestination[]);

                const urlKey = this.getDetectedStreamKey(item.streamId);
                const url = this.storage.getItem(urlKey);

                streams.push({
                    name: item.streamName,
                    id: item.streamId,
                    container: item.ffprobe?.protocol,
                    url,
                    video: {
                        width: item.ffprobe?.video?.width,
                        height: item.ffprobe?.video?.height,
                    },
                    // container: item.container,
                    // destinations,
                });
            });
        }

        this.videoStreamOptions = new Promise(r => r(streams));

        return this.videoStreamOptions;
    }

    async putSetting(key: string, value: SettingValue) {
        // Allow both static and dynamically generated settings.
        if (this.storageSettings.settings[key]) {
            await this.storageSettings.putSetting(key, value);
            return;
        }

        await super.putSetting(key, value);
    }

    async getSettings(): Promise<Setting[]> {
        await this.refreshSettings();
        return await this.storageSettings.getSettings();
    }
}

export default FrigateBridgeCamera;