import { MediaObject, PictureOptions, Setting } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import EventEmitter from "events";
import { UrlMediaStreamOptions } from '../../scrypted/plugins/ffmpeg-camera/src/common';
import { Destroyable, RtspSmartCamera, createRtspMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import FrigateBridgePlugin from "./main";

class FrigateBridgeBirdseyeCamera extends RtspSmartCamera {
    takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject> {
        return null;
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
    videoStreamOptions: Promise<UrlMediaStreamOptions[]>;

    storageSettings = new StorageSettings(this, {
    });

    constructor(nativeId: string, public provider: FrigateBridgePlugin) {
        super(nativeId, provider);
    }

    createRtspMediaStreamOptions(url: string, index: number) {
        const ret = createRtspMediaStreamOptions(url, index);
        ret.tool = 'scrypted';
        return ret;
    }

    async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        const { serverUrl } = this.provider.storageSettings.values;
        const address = new URL(serverUrl).hostname;

        const streams: UrlMediaStreamOptions[] = [
            {
                name: 'Birdseye',
                id: 'birdseye',
                container: 'rtsp',
                url: `rtsp://${address}:8554/birdseye`
            },
        ];

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

    showRtspUrlOverride() {
        return false;
    }

    async getSettings(): Promise<Setting[]> {
        return await this.storageSettings.getSettings();
    }
}

export default FrigateBridgeBirdseyeCamera;