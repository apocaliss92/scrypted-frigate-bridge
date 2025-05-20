import sdk, { MediaObject, ScryptedDeviceBase, Setting, Settings, SettingValue, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { detectionClassesDefaultMap } from "../../scrypted-advanced-notifier/src/detectionClasses";
import { baseFrigateApi, FrigateVideoClip } from "./utils";
import FrigateBridgeVideoclips from "./videoclips";

export class FrigateBridgeVideoclipsMixin extends SettingsMixinDeviceBase<any> implements Settings, VideoClips {
    storageSettings = new StorageSettings(this, {
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            immediate: true,
        },
    });

    logger: Console;
    cameraDevice: ScryptedDeviceBase;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeVideoclips
    ) {
        super(options);
        this.cameraDevice = sdk.systemManager.getDeviceById<ScryptedDeviceBase>(this.id);

        this.plugin.currentMixinsMap[this.id] = this;
    }

    getLogger() {
        return this.plugin.getLogger(this.cameraDevice);
    }

    getVideoclipUrls(eventId: string) {
        const videoUrl = `${this.plugin.plugin.storageSettings.values.serverUrl}/events/${eventId}/clip.mp4`;
        const snapshotCleanUrl = `${this.plugin.plugin.storageSettings.values.serverUrl}/events/${eventId}/snapshot-clean.png`;
        const thumbnailUrl = `${this.plugin.plugin.storageSettings.values.serverUrl}/events/${eventId}/thumbnail.jpg`;

        return {
            videoUrl,
            thumbnailUrl,
            snapshotCleanUrl,
        };
    }

    async getVideoclipWebhookUrls(eventId: string) {
        const cloudEndpoint = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });
        const [endpoint, parameters] = cloudEndpoint.split('?') ?? '';
        const params = {
            deviceId: this.id,
            eventId,
        }

        const videoclipUrl = `${endpoint}videoclip?params=${JSON.stringify(params)}&${parameters}`;
        const thumbnailUrl = `${endpoint}thumbnail?params=${JSON.stringify(params)}&${parameters}`;

        return { videoclipUrl, thumbnailUrl };
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        const { count, endTime, startTime } = options;
        const logger = this.getLogger();

        try {
            const service = `events`;

            const params = {
                camera: this.storageSettings.values.cameraName,
                after: startTime / 1000,
                before: endTime / 1000,
                limit: count || 10000,
                // has_clip: true,
                // has_snapshot: true,
                // in_progress: false,
                // include_thumbnails: false,
            };

            const res = await baseFrigateApi({
                apiUrl: this.plugin.plugin.storageSettings.values.serverUrl,
                service,
                params
            });

            logger.debug('getFrigateEvents', options, res.data);

            const events = res.data as FrigateVideoClip[];
            const filteredEvents = events
                .filter(event => event.has_clip && event.has_snapshot && event.data.type === 'object');
            // .filter(event => event.has_clip && event.has_snapshot && event.data.max_severity === 'alert');

            const videoclips: VideoClip[] = [];
            for (const event of filteredEvents) {

                const startTime = event.start_time * 1000;
                const endTime = event.end_time * 1000;
                const { thumbnailUrl, videoclipUrl } = await this.getVideoclipWebhookUrls(event.id);

                const videoclip: VideoClip = {
                    id: event.id,
                    startTime,
                    duration: endTime - startTime,
                    detectionClasses: [detectionClassesDefaultMap[event.label]],
                    event: event.label,
                    thumbnailId: event.id,
                    videoId: event.id,
                    resources: {
                        video: {
                            href: videoclipUrl,
                        },
                        thumbnail: {
                            href: thumbnailUrl,
                        },
                    }
                };

                videoclips.push(videoclip);
            }

            return videoclips;

        } catch (e) {
            logger.error('Error in getRecordedEvents', e);
            return [];
        }
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.getLogger();

        try {
            const { videoUrl } = this.getVideoclipUrls(videoId);
            const mo = await sdk.mediaManager.createMediaObjectFromUrl(videoUrl);

            return mo;
        } catch (e) {
            logger.error('Error in getVideoClip', videoId, e);
        }
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();

        try {
            const { thumbnailUrl } = this.getVideoclipUrls(thumbnailId);
            const mo = await sdk.mediaManager.createMediaObjectFromUrl(thumbnailUrl);

            return mo;
        } catch (e) {
            logger.error('Error in getVideoClip', thumbnailId, e);
        }
    }

    removeVideoClips(...videoClipIds: string[]): Promise<void> {
        throw new Error("Method not implemented.");
    }

    async getMixinSettings(): Promise<Setting[]> {
        try {
            this.storageSettings.settings.cameraName.choices = this.plugin.plugin.storageSettings.values.cameras;
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
    }
}
