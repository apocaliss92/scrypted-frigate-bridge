import sdk, { DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, ScryptedDeviceType, ScryptedInterface, SettingValue } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { BasePlugin } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgeObjectDetector from "./objectDetector";
import FrigateBridgeVideoclips from "./videoclips";
import { FrigateBridgeVideoclipsMixin } from "./videoclipsMixin";
import http from 'http';

const objectDetectorNativeId = 'frigateObjectDetector'
const videoclipsNativeId = 'frigateVideoclips'
const cameraNativeId = 'frigateBirdseyeCamera'

export default class FrigateBridgePlugin extends BasePlugin implements DeviceProvider, HttpRequestHandler {
    initStorage: StorageSettingsDict<string> = {
        serverUrl: {
            title: 'Frigate server API URL',
            description: 'URL to the Frigate server. Example: http://192.168.1.100:5000/api',
            type: 'string',
        },
        importBirdseyeCamera: {
            title: 'Import Birdseye camera',
            type: 'boolean',
            immediate: true,
            onPut: async (_, active) => await this.executeCameraDiscovery(active)
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    objectDetectorDevice: FrigateBridgeObjectDetector;
    videoclipsDevice: FrigateBridgeVideoclips;

    constructor(nativeId: string) {
        super(nativeId, {
            pluginFriendlyName: 'Frigate Bridge',
        });

        (async () => {
            await sdk.deviceManager.onDeviceDiscovered(
                {
                    name: 'Frigate Object Detector',
                    nativeId: objectDetectorNativeId,
                    interfaces: [ScryptedInterface.MixinProvider, ScryptedInterface.Settings],
                    type: ScryptedDeviceType.API,
                }
            );
            await sdk.deviceManager.onDeviceDiscovered(
                {
                    name: 'Frigate Videoclips',
                    nativeId: videoclipsNativeId,
                    interfaces: [ScryptedInterface.MixinProvider, ScryptedInterface.Settings],
                    type: ScryptedDeviceType.API,
                }
            );
        })();

        // (async () => {
        //     await sdk.deviceManager.onDeviceDiscovered(
        //         {
        //             name: 'Advanced notifier NVR notifier',
        //             nativeId: defaultNotifierNativeId,
        //             interfaces: [ScryptedInterface.Notifier],
        //             type: ScryptedDeviceType.Notifier,
        //         },
        //     );

        //     await this.executeCameraDiscovery(this.storageSettings.values.enableCameraDevice);
        // })();
    }

    async executeCameraDiscovery(active: boolean) {
        const interfaces: ScryptedInterface[] = [ScryptedInterface.Camera, ScryptedInterface.VideoClips];

        if (active) {
            interfaces.push(ScryptedInterface.VideoCamera);
        }

        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Frigate Birdseye',
                nativeId: cameraNativeId,
                interfaces,
                type: ScryptedDeviceType.Camera,
            }
        );
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const url = new URL(`http://localhost${request.url}`);
        const params = url.searchParams.get('params') ?? '{}';

        try {
            const [_, __, ___, ____, _____, webhook] = url.pathname.split('/');
            // const [_, __, ___, ____, webhook] = url.pathname.split('/');
            const { deviceId, eventId, parameters } = JSON.parse(params);
            const dev: FrigateBridgeVideoclipsMixin = this.videoclipsDevice.currentMixinsMap[deviceId];
            const devConsole = dev.getLogger();
            devConsole.debug(`Request with parameters: ${JSON.stringify({
                webhook,
                deviceId,
                eventId,
                parameters
            })}`);

            try {
                if (webhook === 'videoclip') {
                    devConsole
                    const range = request.headers.range;
                    devConsole.log('range is ', range);

                    // if (range) {
                    //     const parts = range.replace(/bytes=/, "").split("-");
                    //     const start = parseInt(parts[0], 10);
                    //     const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

                    //     const chunksize = (end - start) + 1;
                    //     const file = fs.createReadStream(videoClipPath, { start, end });

                    //     const sendVideo = async () => {
                    //         return new Promise<void>((resolve, reject) => {
                    //             try {
                    //                 response.sendStream((async function* () {
                    //                     for await (const chunk of file) {
                    //                         yield chunk;
                    //                     }
                    //                 })(), {
                    //                     code: 206,
                    //                     headers: {
                    //                         'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    //                         'Accept-Ranges': 'bytes',
                    //                         'Content-Length': chunksize,
                    //                         'Content-Type': 'video/mp4',
                    //                     }
                    //                 });

                    //                 resolve();
                    //             } catch (err) {
                    //                 reject(err);
                    //             }
                    //         });
                    //     };

                    //     try {
                    //         await sendVideo();
                    //         return;
                    //     } catch (e) {
                    //         devConsole.log('Error fetching videoclip', e);
                    //     }
                    // } else {
                    // devConsole.log(`Videoclip requested via API: ${JSON.stringify({
                    //     videoclipPath,
                    //     deviceId,
                    //     playbackPathWithHost,
                    // })}`);

                    const { videoUrl } = dev.getVideoclipUrls(eventId);
                    const sendVideo = async () => {
                        return new Promise<void>((resolve, reject) => {
                            http.get(videoUrl, { headers: request.headers }, (httpResponse) => {
                                if (httpResponse.statusCode[0] === 400) {
                                    reject(new Error(`Error loading the video: ${httpResponse.statusCode} - ${httpResponse.statusMessage}. Headers: ${JSON.stringify(request.headers)}`));
                                    return;
                                }

                                try {
                                    response.sendStream((async function* () {
                                        for await (const chunk of httpResponse) {
                                            yield chunk;
                                        }
                                    })(), {
                                        headers: httpResponse.headers
                                    });

                                    resolve();
                                } catch (err) {
                                    reject(err);
                                }
                            }).on('error', (e) => {
                                devConsole.log('Error fetching videoclip', e);
                                reject(e)
                            });
                        });
                    };

                    try {
                        await sendVideo();
                        return;
                    } catch (e) {
                        devConsole.log('Error fetching videoclip', e);
                    }
                    // }

                    return;
                } else
                    if (webhook === 'thumbnail') {
                        const thumbnailMo = await dev.getVideoClipThumbnail(eventId);
                        const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(thumbnailMo, 'image/jpeg');
                        response.send(jpeg, {
                            headers: {
                                'Content-Type': 'image/jpeg',
                            }
                        });
                        return;
                    }
            } catch (e) {
                devConsole.log(`Error in webhook`, e);
                response.send(`${JSON.stringify(e)}, ${e.message}`, {
                    code: 400,
                });

                return;
            }

            response.send(`Webhook not found: ${url.pathname}`, {
                code: 404,
            });

            return;
        } catch (e) {
            this.console.log('Error in data parsing for webhook', e);
            response.send(`Error in data parsing for webhook: ${JSON.stringify({
                params,
                url: request.url
            })}`, {
                code: 500,
            });
        }
    }

    async getDevice(nativeId: string) {
        if (nativeId === objectDetectorNativeId)
            return this.objectDetectorDevice ||= new FrigateBridgeObjectDetector(objectDetectorNativeId, this);
        if (nativeId === videoclipsNativeId)
            return this.videoclipsDevice ||= new FrigateBridgeVideoclips(videoclipsNativeId, this);
        // TODO: Implement birdseye camera
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async getMqttClient() {
        return await super.getMqttClient('scrypted_frigate_object_detector');
    }

    async getSettings() {
        try {
            const settings = await super.getSettings();
            return settings;
        } catch (e) {
            this.getLogger().log('Error in getSettings', e);
            return [];
        }
    }
}

