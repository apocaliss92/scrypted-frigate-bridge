import sdk, { MediaObject, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetector, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { detectionClassesDefaultMap } from "../../scrypted-advanced-notifier/src/detecionClasses";
import { getBaseLogger } from "../../scrypted-apocaliss-base/src/basePlugin";
import FrigateBridgeObjectDetector from "./objectDetector";
import { baseFrigateApi, convertFrigateBoxToScryptedBox, FrigateEvent, FrigateObjectDetection } from "./utils";

export class FrigateBridgeObjectDetectorMixin extends SettingsMixinDeviceBase<any> implements Settings, ObjectDetector {
    storageSettings = new StorageSettings(this, {
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
        },
    });

    logger: Console;

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeObjectDetector
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;
    }

    getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        const logger = this.getLogger();
        logger.log('getDetectionInput', detectionId);

        const mo = sdk.mediaManager.createMediaObjectFromUrl(`${this.plugin.storageSettings.values.serverUrl}/events/${detectionId}/snapshot.jpg`);
        return mo;
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        const res = await baseFrigateApi({
            apiUrl: this.plugin.storageSettings.values.serverUrl,
            service: 'labels',
        });

        const classes = res.data as string[];
        return { classes }
    }

    onFrigateEvent(event: FrigateEvent) {
        const boundingBox: ObjectDetectionResult['boundingBox'] = convertFrigateBoxToScryptedBox(event.after.box);
        const className = detectionClassesDefaultMap[event.after.label] || event.after.label;

        const detection: FrigateObjectDetection = {
            frigateEvent: event,
            timestamp: event.after.start_time * 1000,
            detectionId: event.after.id,
            inputDimensions: [0, 0],
            detections: [
                { className: 'motion', score: 1, boundingBox },
                {
                    className,
                    score: event.after.score,
                    boundingBox,
                    movement: {
                        moving: event.after.active,
                        firstSeen: event.after.start_time * 1000,
                        lastSeen: event.after.end_time * 1000,
                    },
                    zones: event.after.current_zones,
                },
            ]
        };

        this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection);
    }

    async getMixinSettings(): Promise<Setting[]> {
        try {
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

    public getLogger() {
        return this.plugin.getLogger();
    }
}
