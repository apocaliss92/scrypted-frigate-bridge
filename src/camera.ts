import sdk, { MediaObject, MediaStreamDestination, PictureOptions, Setting, SettingValue } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import { UrlMediaStreamOptions } from '../../scrypted/plugins/ffmpeg-camera/src/common';
import { Destroyable, RtspSmartCamera, createRtspMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import FrigateBridgePlugin from "./main";
import { StreamSource, audioDetectorNativeId, birdseyeStreamName, motionDetectorNativeId, objectDetectorNativeId, videoclipsNativeId } from "./utils";

class FrigateBridgeCamera extends RtspSmartCamera {
    storageSettings = new StorageSettings(this, {
        logLevel: {
            ...logLevelSetting,
        },
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            readonly: true
        },
        detectedStreamsDefaultPreset: {
            title: 'Detected streams default preset',
            description: 'Default preset applied to newly detected streams when no per-stream preset is configured.',
            type: 'string',
            hide: true,
        },
        nativeMixinsAdded: {
            type: 'boolean',
            hide: true
        },
    });
    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    streamsData: { path: string, roles: string[] }[] = [];
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

    private readonly detectedStreamsGroup = 'Detected streams';

    private readonly detectedStreamPresetChoices = Object.values(StreamSource);

    private isDetectedStreamPreset(value: StreamSource) {
        return this.detectedStreamPresetChoices.includes(value);
    }

    private getDetectedStreamKey(index: number, field: 'preset' | 'url' | 'go2rtcStream' | 'destinations' | 'roles') {
        return `detectedStream:${index}:${field}`;
    }

    private getGo2RtcStreamNames(): string[] {
        const raw = this.provider?.storageSettings?.values?.go2rtcStreams as any;
        const data = (typeof raw === 'string')
            ? (() => {
                try {
                    return JSON.parse(raw);
                } catch {
                    return undefined;
                }
            })()
            : raw;

        if (!data)
            return [];

        const streamsObj = (data?.streams && typeof data.streams === 'object') ? data.streams : data;
        if (!streamsObj || typeof streamsObj !== 'object')
            return [];

        return Object.keys(streamsObj)
            .filter(name => name !== 'birdseye')
            .sort();
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

    private safeParseStringArray(raw: string | undefined | null): string[] | undefined {
        if (!raw)
            return undefined;

        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed))
                return parsed.map(v => String(v));
        } catch {
        }

        // Fallback: comma-separated.
        const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
        return parts.length ? parts : undefined;
    }

    private getDetectedStreamsSettingsChoices(): MediaStreamDestination[] {
        return [
            'local',
            'remote',
            'medium-resolution',
            'low-resolution',
            'local-recorder',
            'remote-recorder',
        ];
    }

    private isMediaStreamDestination(value: string): value is MediaStreamDestination {
        return this.getDetectedStreamsSettingsChoices().includes(value as MediaStreamDestination);
    }

    private refreshDetectedStreamsSettings() {
        if (!this.isBirdseyeCamera) {
            return;
        }

        const destinationChoices = this.getDetectedStreamsSettingsChoices();
        const streams = this.streamsData ?? [];
        const go2rtcStreamNames = this.getGo2RtcStreamNames();

        const { detectedStreamsDefaultPreset } = this.storageSettings.values;
        const defaultPreset = this.isDetectedStreamPreset(detectedStreamsDefaultPreset)
            ? detectedStreamsDefaultPreset
            : this.provider.storageSettings.values.detectedStreamsDefaultPreset;

        for (let index = 0; index < streams.length; index++) {
            const { path, roles } = streams[index];
            const isHigh = roles?.includes('record');
            const defaultDestinations = isHigh
                ? (['local', 'local-recorder', 'medium-resolution'] as MediaStreamDestination[])
                : (['medium-resolution', 'remote', 'remote-recorder'] as MediaStreamDestination[]);

            const subgroup = `Stream ${index + 1}`;

            const presetKey = this.getDetectedStreamKey(index, 'preset');
            const urlKey = this.getDetectedStreamKey(index, 'url');
            const go2rtcStreamKey = this.getDetectedStreamKey(index, 'go2rtcStream');
            const destinationsKey = this.getDetectedStreamKey(index, 'destinations');
            const rolesKey = this.getDetectedStreamKey(index, 'roles');

            const storedPreset = this.storage.getItem(presetKey) as StreamSource;
            const preset = (this.isDetectedStreamPreset(storedPreset) ? storedPreset : defaultPreset);
            const isInput = preset === StreamSource.Input;

            this.storageSettings.settings[presetKey] = {
                title: 'Streams source preset',
                description: 'Source used for the streams. Input will use the urls configured on Frigate, go2Rtc will use the go2Rtc exposed streams.',
                type: 'string',
                group: this.detectedStreamsGroup,
                subgroup,
                immediate: true,
                combobox: true,
                choices: [...this.detectedStreamPresetChoices],
                defaultValue: defaultPreset,
                onPut: async () => {
                    this.refreshDetectedStreamsSettings();
                }
            };

            this.storageSettings.settings[urlKey] = {
                title: 'URL',
                type: 'string',
                group: this.detectedStreamsGroup,
                subgroup,
                defaultValue: path,
                // readonly: true,
                hide: !isInput,
            };

            this.storageSettings.settings[go2rtcStreamKey] = {
                title: 'go2Rtc stream',
                type: 'string',
                group: this.detectedStreamsGroup,
                subgroup,
                immediate: true,
                combobox: true,
                choices: go2rtcStreamNames,
                hide: isInput,
                onPut: async () => {
                    this.refreshDetectedStreamsSettings();
                }
            };

            this.storageSettings.settings[destinationsKey] = {
                title: 'Destinations',
                type: 'string',
                group: this.detectedStreamsGroup,
                subgroup,
                multiple: true,
                combobox: true,
                choices: destinationChoices,
                defaultValue: defaultDestinations,
            };

            this.storageSettings.settings[rolesKey] = {
                title: 'Roles',
                type: 'string',
                group: this.detectedStreamsGroup,
                subgroup,
                multiple: true,
                readonly: true,
                defaultValue: roles ?? [],
                choices: ['detect', 'record', 'audio'],
            };
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
        // Prefer raw YAML config (config/raw) because it matches the user's configured URLs,
        // fallback to parsed config endpoint if unavailable.
        const rawJson = await this.provider.getConfigurationRawJson();
        const rawInputs = rawJson?.cameras?.[this.cameraName]?.ffmpeg?.inputs;

        const config = rawInputs ? undefined : await this.provider.getConfiguration();
        const inputs = (rawInputs ?? config?.cameras?.[this.cameraName]?.ffmpeg?.inputs ?? []) as any[];

        this.streamsData = (Array.isArray(inputs) ? inputs : [])
            .map((i: any) => {
                const path = (typeof i === 'string') ? i : i?.path;
                const roles = (Array.isArray(i?.roles) ? i.roles : [])
                    .map((r: any) => String(r));
                if (!path)
                    return undefined;
                return {
                    path: String(path),
                    roles,
                };
            })
            .filter(Boolean) as { path: string, roles: string[] }[];

        if (!this.isBirdseyeCamera) {
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

            this.refreshDetectedStreamsSettings();
        }
    }

    getSnapshotUrl(): string {
        const { serverUrl } = this.provider.storageSettings.values;
        const { cameraName } = this.storageSettings.values;
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
                    destinations: this.getDetectedStreamsSettingsChoices(),
                });
            }
        } else {
            this.streamsData?.forEach(({ path, roles }, index) => {
                this.refreshDetectedStreamsSettings();

                const isHigh = roles.includes('record');

                const presetKey = this.getDetectedStreamKey(index, 'preset');
                const urlKey = this.getDetectedStreamKey(index, 'url');
                const go2rtcStreamKey = this.getDetectedStreamKey(index, 'go2rtcStream');
                const destinationsKey = this.getDetectedStreamKey(index, 'destinations');

                const storedPreset = this.storage.getItem(presetKey) as StreamSource
                const preset = this.isDetectedStreamPreset(storedPreset)
                    ? storedPreset
                    : this.provider.storageSettings.values.detectedStreamsDefaultPreset;

                let url: string;
                if (preset === StreamSource.Go2rtc) {
                    const streamName = (this.storage.getItem(go2rtcStreamKey) || '');
                    url = this.getGo2RtcUrlForStreamName(streamName) || path;
                } else {
                    url = this.storage.getItem(urlKey) || path;
                }

                const destinationsFromStorage = this.safeParseStringArray(this.storage.getItem(destinationsKey));
                const filtered = destinationsFromStorage
                    ?.filter((d): d is MediaStreamDestination => this.isMediaStreamDestination(d));
                const destinations: MediaStreamDestination[] = (filtered?.length ? filtered : undefined) ?? (isHigh
                    ? (['local', 'local-recorder', 'medium-resolution'] as MediaStreamDestination[])
                    : (['medium-resolution', 'remote', 'remote-recorder'] as MediaStreamDestination[]));

                streams.push({
                    name: `Stream ${index + 1}`,
                    id: `stream_${index + 1}`,
                    container: 'rtsp',
                    url,
                    destinations,
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
        this.refreshDetectedStreamsSettings();
        return await this.storageSettings.getSettings();
    }
}

export default FrigateBridgeCamera;