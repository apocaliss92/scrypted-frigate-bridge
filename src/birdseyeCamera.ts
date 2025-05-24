import { Setting } from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { UrlMediaStreamOptions } from '../../scrypted/plugins/ffmpeg-camera/src/common';
import { Destroyable, RtspCamera, RtspSmartCamera, createRtspMediaStreamOptions } from '../../scrypted/plugins/rtsp/src/rtsp';
import FrigateBridgePlugin from "./main";
import { PictureOptions, MediaObject } from "@scrypted/sdk";

class FrigateBridgeBirdseyeCamera extends RtspSmartCamera {
    takeSmartCameraPicture(options?: PictureOptions): Promise<MediaObject> {
        throw new Error("Method not implemented.");
    }
    listenEvents(): Promise<Destroyable> {
        throw new Error("Method not implemented.");
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