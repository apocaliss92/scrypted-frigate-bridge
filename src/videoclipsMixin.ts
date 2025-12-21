import sdk, { MediaObject, ScryptedDeviceBase, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import { detectionClassesDefaultMap } from "../../scrypted-advanced-notifier/src/detectionClasses";
import { baseFrigateApi, FrigateVideoClip, guessBestCameraName, initFrigateMixin, pluginId } from "./utils";
import FrigateBridgeVideoclips from "./videoclips";
import { sortBy } from "lodash";
import axios from "axios";

export class FrigateBridgeVideoclipsMixin extends SettingsMixinDeviceBase<any> implements Settings, VideoClips {
    storageSettings = new StorageSettings(this, {
        logLevel: {
            ...logLevelSetting,
        },
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            immediate: true,
        },
        fetchMixinClips: {
            title: 'Fetch upstream mixin clips',
            type: 'boolean',
            immediate: true,
            defaultValue: false
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

        const logger = this.getLogger();
        this.init().catch(logger.error);
    }

    async init() {
        await initFrigateMixin({
            mixin: this,
            storageSettings: this.storageSettings,
            plugin: this.plugin.plugin,
            logger: this.getLogger(),
        });
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
        const logger = this.getLogger();

        let url: string;
        try {
            try {
                url = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });
            } catch {
                url = await sdk.endpointManager.getLocalEndpoint(undefined, { public: true })
            }

            const [endpoint, parameters] = url.split('?') ?? '';
            const params = {
                deviceId: this.id,
                eventId,
            }
            const pathnamePrefix = new URL(url).pathname;

            const parametersParsed = parameters ? `&${parameters}` : '';
            const videoclipUrl = `${endpoint}videoclip?params=${JSON.stringify(params)}${parametersParsed}`;
            const thumbnailUrl = `${endpoint}thumbnail?params=${JSON.stringify(params)}${parametersParsed}`;
            const videoclipHref = `${pathnamePrefix}videoclip?params=${JSON.stringify(params)}${parametersParsed}`;
            const thumbnailHref = `${pathnamePrefix}thumbnail?params=${JSON.stringify(params)}${parametersParsed}`;

            return { videoclipUrl, thumbnailUrl, videoclipHref, thumbnailHref };
        } catch (e) {
            logger.log(`Error fetching cloud endpoint`, e);
            return {};
        }
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        const { count, endTime, startTime } = options ?? {};
        const { cameraName, fetchMixinClips } = this.storageSettings.values;
        const logger = this.getLogger();

        const videoclips: VideoClip[] = [];

        if (fetchMixinClips) {
            try {
                const deviceClips = await this.mixinDevice.getVideoClips(options);
                videoclips.push(...deviceClips);
            } catch { }
        }

        if (!cameraName) {
            logger.log('Camera name not set');
            return videoclips;
        }

        try {
            const service = `events`;

            const params = {
                camera: cameraName,
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
                .filter(event =>
                    event.has_clip &&
                    event.has_snapshot &&
                    event.data.type === 'object'
                );
            // .filter(event => event.has_clip && event.has_snapshot && event.data.max_severity === 'alert');

            for (const event of filteredEvents) {
                const startTime = event.start_time * 1000;
                const endTime = event.end_time * 1000;
                const { thumbnailUrl, videoclipUrl } = await this.getVideoclipWebhookUrls(event.id);

                const videoclip: VideoClip = {
                    id: event.id,
                    startTime,
                    duration: endTime - startTime,
                    description: pluginId,
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

            return sortBy(videoclips, 'startTime');;
        } catch (e) {
            logger.error('Error in getRecordedEvents', e);
            return [];
        }
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.getLogger();

        try {
            const { videoUrl } = this.getVideoclipUrls(videoId);
            await axios.get(videoUrl, {
                headers: {
                    Range: "bytes=0-99"
                },
                responseType: "arraybuffer",
            });

            const { videoclipUrl } = await this.getVideoclipWebhookUrls(videoId);
            const mo = await sdk.mediaManager.createMediaObject(Buffer.from(videoclipUrl), ScryptedMimeTypes.LocalUrl, {
                sourceId: this.plugin.id
            });

            return mo;
        } catch {
            try {
                return this.mixinDevice.getVideoClip(videoId);
            } catch (e) {
                logger.error('Error in getVideoClip', videoId, e);
            }
        }
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();

        try {
            const { thumbnailUrl } = this.getVideoclipUrls(thumbnailId);
            const jpeg = await axios.get(thumbnailUrl, {
                responseType: "arraybuffer",
            });

            const mo = await sdk.mediaManager.createMediaObject(jpeg.data, 'image/jpeg');

            return mo;
        } catch {
            try {
                return this.mixinDevice.getVideoClipThumbnail(thumbnailId, options);
            } catch (e) {
                logger.error('Error in getVideoClipThumbnail', thumbnailId, e);
            }
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
