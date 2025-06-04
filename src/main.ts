import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, VideoCamera } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import http from 'http';
import { applySettingsShow, BaseSettingsKey, getBaseLogger, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import { RtspProvider } from "../../scrypted/plugins/rtsp/src/rtsp";
import FrigateBridgeAudioDetector from "./audioDetector";
import FrigateBridgeBirdseyeCamera from "./birdseyeCamera";
import FrigateBridgeCamera from "./camera";
import FrigateBridgeClassifier from "./classsifier";
import FrigateBridgeMotionDetector from "./motionDetector";
import FrigateBridgeObjectDetector from "./objectDetector";
import { animalClassifierNativeId, audioDetectorNativeId, baseFrigateApi, birdseyeCameraNativeId, importedCameraNativeIdPrefix, motionDetectorNativeId, objectDetectorNativeId, toSnakeCase, vehicleClassifierNativeId, videoclipsNativeId } from "./utils";
import FrigateBridgeVideoclips from "./videoclips";
import { FrigateBridgeVideoclipsMixin } from "./videoclipsMixin";

type StorageKey = BaseSettingsKey |
    'serverUrl' |
    'labels' |
    'cameras' |
    'exportCameraDevice' |
    'exportWithRebroadcast' |
    'enableBirdseyeCamera' |
    'logLevel' |
    'exportButton';

export default class FrigateBridgePlugin extends RtspProvider implements DeviceProvider, HttpRequestHandler, DeviceCreator {
    initStorage: StorageSettingsDict<StorageKey> = {
        ...getBaseSettings({
            onPluginSwitch: (_, enabled) => {
                this.startStop(enabled);
            },
            hideHa: true,
            baseGroupName: '',
        }),
        serverUrl: {
            title: 'Frigate server API URL',
            description: 'URL to the Frigate server. Example: http://192.168.1.100:5000/api',
            type: 'string',
        },
        labels: {
            title: 'Available labels',
            type: 'string',
            readonly: true,
            multiple: true,
            choices: [],
        },
        cameras: {
            title: 'Available cameras',
            type: 'string',
            readonly: true,
            multiple: true,
            choices: [],
        },
        enableBirdseyeCamera: {
            title: 'Enable birdseye camera',
            type: 'boolean',
            immediate: true,
            defaultValue: true,
        },
        exportCameraDevice: {
            title: 'Camera',
            group: 'Export camera',
            type: 'device',
            immediate: true,
            deviceFilter: `interfaces.some(int => ['${ScryptedInterface.Camera}', '${ScryptedInterface.VideoCamera}'].includes(int))`
        },
        exportWithRebroadcast: {
            title: 'Export with rebroadcast',
            description: 'If checked will provide rebroadcast urls, otherwise camera ones',
            group: 'Export camera',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        exportButton: {
            title: 'Export',
            group: 'Export camera',
            type: 'button',
            onPut: async () => await this.exportCamera()
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);

    objectDetectorDevice: FrigateBridgeObjectDetector;
    motionDetectorDevice: FrigateBridgeMotionDetector;
    audioDetectorDevice: FrigateBridgeAudioDetector;
    videoclipsDevice: FrigateBridgeVideoclips;
    birdseyeCamera: FrigateBridgeBirdseyeCamera;
    animalClassifier: FrigateBridgeClassifier;
    vehicleClassifier: FrigateBridgeClassifier;
    camerasMap: Record<string, FrigateBridgeCamera> = {};
    logger: Console;
    config: any;

    constructor(nativeId: string) {
        super(nativeId);
        const logger = this.getLogger();

        this.initData().catch(logger.log);
    }

    async startStop(enabled: boolean) {
        if (enabled) {
            await this.start();
        } else {
            await this.stop();
        }
    }

    async stop() {
        await this.motionDetectorDevice?.stop();
        await this.audioDetectorDevice?.stop();
        await this.objectDetectorDevice?.stop();
    }

    async start() {
        try {
            await this.motionDetectorDevice?.start();
            await this.audioDetectorDevice?.start();
            await this.objectDetectorDevice?.start();
        } catch (e) {
            this.getLogger().log(`Error in initFlow`, e);
        }
    }

    getLogger(props?: {
        console: Console,
        storage: StorageSettings<any>,
    }) {
        const { console, storage } = props ?? {};

        if (console && storage) {
            return getBaseLogger({
                console,
                storage,
            });
        } else if (!this.logger) {
            this.logger = getBaseLogger({
                console: this.console,
                storage: this.storageSettings,
            });
        }

        return this.logger;
    }

    getScryptedDeviceCreator(): string {
        return 'Frigate birdseye camera';
    }

    async getConfiguration() {
        const configsResponse = await baseFrigateApi({
            apiUrl: this.storageSettings.values.serverUrl,
            service: 'config',
        });

        return configsResponse.data;
    }

    async initData() {
        const logger = this.getLogger();

        const fn = async () => {
            const res = await baseFrigateApi({
                apiUrl: this.storageSettings.values.serverUrl,
                service: 'labels',
            });

            const labels = res.data as string[];
            logger.log(`Labels found: ${labels}`);
            this.putSetting('labels', [...labels]);

            this.config = await this.getConfiguration();

            const cameras = Object.keys((this.config ?? {})?.cameras);
            logger.log(`Cameras found: ${cameras}`);
            this.putSetting('cameras', cameras);
        }

        setInterval(async () => await fn(), 1000 * 60 * 10);
        setTimeout(async () => {
            logger.log(`Restarting`);
            await sdk.deviceManager.requestRestart();
        }, 1000 * 60 * 60 * 2);
        await fn();

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
                name: 'Frigate Motion Detector',
                nativeId: motionDetectorNativeId,
                interfaces: [ScryptedInterface.MixinProvider, ScryptedInterface.Settings],
                type: ScryptedDeviceType.API,
            }
        );
        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Frigate Audio Detector',
                nativeId: audioDetectorNativeId,
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
        // await sdk.deviceManager.onDeviceDiscovered(
        //     {
        //         name: 'Frigate Animal Classifier',
        //         nativeId: animalClassifierNativeId,
        //         interfaces: [ScryptedInterface.ObjectDetection, ScryptedInterface.ClusterForkInterface, 'CustomObjectDetection'],
        //         type: ScryptedDeviceType.API,
        //     }
        // );
        // await sdk.deviceManager.onDeviceDiscovered(
        //     {
        //         name: 'Frigate Vehicle Classifier',
        //         nativeId: vehicleClassifierNativeId,
        //         interfaces: [ScryptedInterface.ObjectDetection, ScryptedInterface.ClusterForkInterface, 'CustomObjectDetection'],
        //         type: ScryptedDeviceType.API,
        //     }
        // );

        await this.executeCameraDiscovery(this.storageSettings.values.enableBirdseyeCamera);
        await this.startStop(this.storageSettings.values.pluginEnabled);
    }

    async executeCameraDiscovery(active: boolean) {
        const interfaces: ScryptedInterface[] = [ScryptedInterface.Camera];

        if (active) {
            interfaces.push(ScryptedInterface.VideoCamera);
        }

        await sdk.deviceManager.onDeviceDiscovered(
            {
                name: 'Frigate Birdseye',
                nativeId: birdseyeCameraNativeId,
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
            const { deviceId, eventId } = JSON.parse(params);
            const dev: FrigateBridgeVideoclipsMixin = this.videoclipsDevice.currentMixinsMap[deviceId];
            const devConsole = dev.getLogger();
            devConsole.debug(`Request with parameters: ${JSON.stringify({
                webhook,
                deviceId,
                eventId,
            })}`);

            try {
                if (webhook === 'videoclip') {
                    // const { serverUrl } = this.storageSettings.values;
                    const { videoUrl } = dev.getVideoclipUrls(eventId);
                    // const eventUrl = `${serverUrl}/events/${eventId}`;
                    // const eventResponse = await axios.get<DetectionData>(eventUrl);
                    // const event = eventResponse.data;
                    // const frigateOrigin = new URL(serverUrl).origin;
                    // const vodUrl = `${frigateOrigin}/vod/${event.camera}/start/${event.start_time}/end/${event.end_time}/index.m3u8`;

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
                    // const sendVideo = async () => {
                    //     return new Promise<void>(async (resolve, reject) => {
                    //         const playlistRes = await axios.get<string>(vodUrl);
                    //         const lines = playlistRes.data.split('\n');

                    //         devConsole.log(`Lines found`, lines);
                    //         for (const line of lines) {
                    //             if (line.includes('.mp4') || line.includes('.m4s')) {
                    //                 const parsed = line.replaceAll('#EXT-X-MAP:URI=', '').replaceAll('"', '');
                    //                 const segmentUrl = new URL(parsed, vodUrl).href;
                    //                 devConsole.log(`Segment ${segmentUrl}`);

                    //                 try {
                    //                     const segmentRes = await axios.get<Buffer[]>(segmentUrl, {
                    //                         responseType: 'arraybuffer',
                    //                     });
                    //                     response.sendStream((async function* () {
                    //                         for await (const chunk of segmentRes.data) {
                    //                             devConsole.log(chunk);
                    //                             yield chunk;
                    //                         }
                    //                     })(), {
                    //                         headers: segmentRes.headers
                    //                     });
                    //                 } catch (err) {
                    //                     console.error(`Errore nel segmento: ${segmentUrl}`, err);
                    //                     reject();
                    //                 }
                    //             }
                    //         }
                    //         resolve();
                    //     });
                    // };

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

    async exportCamera() {
        const logger = this.getLogger();
        const { exportCameraDevice, exportWithRebroadcast } = this.storageSettings.values;
        if (!exportCameraDevice) {
            return;
        }
        const cameraDevice = sdk.systemManager.getDeviceById<VideoCamera & Settings>(exportCameraDevice.id);
        const streams = await cameraDevice.getVideoStreamOptions();
        const settings = await cameraDevice.getSettings();

        const highResStream = streams.find(stream => stream.destinations.includes('local'));
        const lowResStream = streams.find(stream => stream.destinations.includes('low-resolution'));

        const restreamHighStreamSetting = settings.find(setting =>
            setting.key === 'prebuffer:rtspRebroadcastUrl' &&
            setting.subgroup === `Stream: ${highResStream.name}`
        );
        const restreamLowStreamSetting = settings.find(setting =>
            setting.key === 'prebuffer:rtspRebroadcastUrl' &&
            setting.subgroup === `Stream: ${lowResStream.name}`
        );

        const localEndpoint = await sdk.endpointManager.getLocalEndpoint();
        const hostname = new URL(localEndpoint).hostname;
        const highResUrl = exportWithRebroadcast ? restreamHighStreamSetting?.value.toString().replace(
            'localhost', hostname
        ) : (highResStream as any).url
        const lowResUrl = exportWithRebroadcast ? restreamLowStreamSetting?.value.toString().replace(
            'localhost', hostname
        ) : (lowResStream as any).url;

        const highHwacclArgs = highResStream.video.codec === 'h265' ?
            'preset-intel-qsv-h265' :
            'preset-intel-qsv-h264';
        const lowHwacclArgs = lowResStream.video.codec === 'h265' ?
            'preset-intel-qsv-h265' :
            'preset-intel-qsv-h264';

        const cameraName = toSnakeCase(cameraDevice.name);
        const cameraConfig = `
${cameraName}:
  ffmpeg:
    inputs:
      - path: ${highResUrl}
        hwaccel_args: ${highHwacclArgs}
        input_args: preset-rtsp-generic
        roles:
          - record
      - path: ${lowResUrl}
        hwaccel_args: ${lowHwacclArgs}
        input_args: preset-rtsp-generic
        roles:
          - detect
          - audio
`;

        logger.log(`Add the following snippet to your cameras configuration`);
        logger.log(cameraConfig);

        // const cameraObj = {
        //     "ffmpeg": {
        //         "inputs": [
        //             {
        //                 "path": highResUrl,
        //                 "hwaccel_args": highHwacclArgs,
        //                 "input_args": "preset-rtsp-generic",
        //                 "roles": [
        //                     "record"
        //                 ]
        //             },
        //             {
        //                 "path": lowResUrl,
        //                 "hwaccel_args": lowHwacclArgs,
        //                 "input_args": "preset-rtsp-generic",
        //                 "roles": [
        //                     "detect",
        //                     "audio"
        //                 ]
        //             }
        //         ]
        //     }
        // };
        // const currentConfig = await this.getConfiguration();
        // const newConfig = {
        //     ...currentConfig,
        //     cameras: {
        //         ...currentConfig.cameras,
        //         [cameraName]: cameraObj,
        //     }
        // };

        // const response = await baseFrigateApi({
        //     apiUrl: this.storageSettings.values.serverUrl,
        //     service: 'config/save',
        //     params: { save_option: 'saveonly' },
        //     body: newConfig,
        //     method: "POST"
        // });
        // logger.log(response);
    }

    getAdditionalInterfaces() {
        return [
            ScryptedInterface.VideoCameraConfiguration,
            ScryptedInterface.Camera,
        ];
    }

    async getDevice(nativeId: string) {
        if (nativeId === objectDetectorNativeId)
            return this.objectDetectorDevice ||= new FrigateBridgeObjectDetector(objectDetectorNativeId, this);

        if (nativeId === motionDetectorNativeId)
            return this.motionDetectorDevice ||= new FrigateBridgeMotionDetector(motionDetectorNativeId, this);

        if (nativeId === audioDetectorNativeId)
            return this.audioDetectorDevice ||= new FrigateBridgeAudioDetector(audioDetectorNativeId, this);

        if (nativeId === videoclipsNativeId)
            return this.videoclipsDevice ||= new FrigateBridgeVideoclips(videoclipsNativeId, this);

        if (nativeId === birdseyeCameraNativeId)
            return this.birdseyeCamera ||= new FrigateBridgeBirdseyeCamera(birdseyeCameraNativeId, this);

        if (nativeId === animalClassifierNativeId)
            return this.animalClassifier ||= new FrigateBridgeClassifier(animalClassifierNativeId, this, 'Animal');

        if (nativeId === vehicleClassifierNativeId)
            return this.vehicleClassifier ||= new FrigateBridgeClassifier(vehicleClassifierNativeId, this, 'Vehicle');

        if (nativeId.startsWith(importedCameraNativeIdPrefix)) {
            const found = this.camerasMap[nativeId];

            if (found) {
                return found;
            } else {
                const [_, cameraName] = nativeId.split('_');
                const newCamera = new FrigateBridgeCamera(nativeId, this, cameraName);
                this.camerasMap[nativeId] = newCamera;
                return newCamera;
            }
        }
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        delete this.camerasMap[nativeId];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    async getSettings() {
        try {
            applySettingsShow(this.storageSettings);
            this.storageSettings.settings.mqttEnabled.hide = true;
            const settings = await this.storageSettings.getSettings();
            return settings;
        } catch (e) {
            this.getLogger().log('Error in getSettings', e);
            return [];
        }
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        const config = await this.getConfiguration();
        const cameraNames = Object.keys(config.cameras);
        return [
            {
                key: 'cameraName',
                title: 'Camera to import',
                type: 'string',
                choices: cameraNames
            },
        ]
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: string): Promise<string> {
        const cameraName = settings.cameraName as string;

        if (!cameraName) {
            this.console.log('Camera name is required');
            return;
        }

        settings.newCamera = cameraName;
        const cameraNativeId = `${importedCameraNativeIdPrefix}_${cameraName}`;
        await super.createDevice(settings, cameraNativeId);

        const device = await this.getDevice(cameraNativeId) as FrigateBridgeCamera;
        device.storageSettings.putSetting('cameraName', cameraName);

        return cameraNativeId;
    }
}

