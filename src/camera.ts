import sdk, { MediaObject, PictureOptions, Setting } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import axios from "axios";
import EventEmitter from "events";
import { UrlMediaStreamOptions } from '../../scrypted/plugins/ffmpeg-camera/src/common';
import { Destroyable, RtspSmartCamera, createRtspMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import FrigateBridgePlugin from "./main";

class FrigateBridgeCamera extends RtspSmartCamera {
    storageSettings = new StorageSettings(this, {
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            readonly: true
        }
    });
    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;
    streamsData: { path: string, roles: string[] }[] = [];
    logger: Console;

    constructor(
        nativeId: string,
        public provider: FrigateBridgePlugin,
        public cameraName: string,
    ) {
        super(nativeId, provider);
        const logger = this.getLogger();

        this.init().catch(logger.log);

        // process.nextTick(async () => {
        //     const videoclipsMixin = sdk.systemManager.getDeviceById(pluginId, videoclipsNativeId);
        //     const motionDetectorMixin = sdk.systemManager.getDeviceById(pluginId, motionDetectorNativeId);
        //     const objectDetectorMixin = sdk.systemManager.getDeviceById(pluginId, objectDetectorNativeId);

        //     const currentMixins = this.mixins;

        //     if (!currentMixins.includes(videoclipsMixin.id)) {
        //         currentMixins.push(videoclipsMixin.id);
        //     }

        //     if (!currentMixins.includes(motionDetectorMixin.id)) {
        //         currentMixins.push(motionDetectorMixin.id);
        //     }

        //     if (!currentMixins.includes(objectDetectorMixin.id)) {
        //         currentMixins.push(objectDetectorMixin.id);
        //     }

        //     const thisDevice = sdk.systemManager.getDeviceById(this.id);
        //     thisDevice.setMixins(currentMixins);
        // });
    }

    getLogger() {
        if (!this.logger) {
            this.logger = this.provider.getLogger({
                console: this.console,
                storage: this.storageSettings,
            });
        }

        return this.logger;
    }

    async init() {
        const config = await this.provider.getConfiguration();
        this.streamsData = config.cameras?.[this.cameraName]?.ffmpeg?.inputs ?? [];

        const streamUrl = this.storage.getItem('snapshot:snapshotUrl');
        if (!streamUrl) {
            this.storage.setItem('snapshot:snapshotUrl', this.getSnapshotUrl());
        }
    }

    getSnapshotUrl(): string {
        const { serverUrl } = this.provider.storageSettings.values;
        const { cameraName } = this.storageSettings.values;
        return `${serverUrl}/${cameraName}/latest.jpg`;
    }

    async takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject> {
        const imageUrl = `${this.getSnapshotUrl()}?ts=${Date.now()}`;
        const image = axios.get(imageUrl, { responseType: "arraybuffer" });

        const mo = await sdk.mediaManager.createMediaObject(image, 'image/jpeg');
        return mo;
    }

    async listenEvents(): Promise<Destroyable> {
        const events = new EventEmitter();
        const ret: Destroyable = {
            on: function (eventName: string | symbol, listener: (...args: any[]) => void): void {
                events.on(eventName, listener);
            },
            destroy: async () => {
            },
            emit: function (eventName: string | symbol, ...args: any[]): boolean {
                return events.emit(eventName, ...args);
            }
        };

        return ret;
    }

    createRtspMediaStreamOptions(url: string, index: number) {
        const ret = createRtspMediaStreamOptions(url, index);
        ret.tool = 'scrypted';
        return ret;
    }

    async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        const streams: UrlMediaStreamOptions[] = [];

        this.streamsData?.forEach(({ path, roles }, index) => {
            const isHigh = roles.includes('record');

            streams.push({
                name: `Stream ${index + 1}`,
                id: `stream_${index + 1}`,
                container: 'rtsp',
                url: path,
                destinations: isHigh ?
                    ['local', 'local-recorder', 'medium-resolution'] :
                    ['medium-resolution', 'remote', 'remote-recorder']
            });
        });

        this.videoStreamOptions = new Promise(r => r(streams));

        return this.videoStreamOptions;
    }

    async putSetting(key: string, value: string) {
        if (this.storageSettings.keys[key]) {
            await this.storageSettings.putSetting(key, value);
        }
        else {
            await super.putSetting(key, value);
        }
    }

    async getSettings(): Promise<Setting[]> {
        return await this.storageSettings.getSettings();
    }
}

export default FrigateBridgeCamera;