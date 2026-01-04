import { EventRecorder, ObjectDetectionResult, RecordedEvent, RecordedEventOptions, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { sortBy } from "lodash";
import { detectionClassesDefaultMap } from "../../scrypted-advanced-notifier/src/detectionClasses";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgeEventsRecorder from "./frigateEventsRecorder";
import { baseFrigateApi, convertFrigateBoxToScryptedBox, ensureMixinsOrder, FrigateVideoClip, initFrigateMixin } from "./utils";

export class FrigateBridgeEventsRecorderMixin extends SettingsMixinDeviceBase<any> implements Settings, EventRecorder {
    storageSettings = new StorageSettings<string>(this, {
        logLevel: {
            ...logLevelSetting,
        },
        cameraName: {
            title: 'Frigate camera name',
            type: 'string',
            choices: [],
            immediate: true,
        },
        eventTypes: {
            title: 'Event types',
            type: 'string',
            multiple: true,
            combobox: true,
            immediate: true,
            choices: ['new', 'update', 'end'],
            defaultValue: ['new', 'update', 'end']
        },
        boxExtensionPercent: {
            title: 'Bounding box extension (%)',
            type: 'number',
            description: 'Percentage to extend bounding boxes (default: 10)',
            defaultValue: '10',
            immediate: true,
        },
    });

    logger: Console;
    inputDimensions: [number, number];

    constructor(
        options: SettingsMixinDeviceOptions<any>,
        public plugin: FrigateBridgeEventsRecorder
    ) {
        super(options);

        this.plugin.currentMixinsMap[this.id] = this;

        const logger = this.getLogger();
        this.init().catch(logger.error);
    }

    async init() {
        const logger = this.getLogger();
        ensureMixinsOrder({
            mixin: this,
            plugin: this.plugin.plugin,
            logger,
        });
        await initFrigateMixin({
            mixin: this,
            storageSettings: this.storageSettings,
            plugin: this.plugin.plugin,
            logger,
        });

        const streamOptions = await this.mixinDevice.getVideoStreamOptions();
        const localRecorderFound = streamOptions.find(option => option.destinations.includes('local-recorder'));
        if (localRecorderFound) {
            logger.log('localRecorderFound', JSON.stringify(localRecorderFound));
            this.inputDimensions = [localRecorderFound.video.width, localRecorderFound.video.height];
        }
    }

    async getRecordedEvents(options?: RecordedEventOptions): Promise<RecordedEvent[]> {
        const { cameraName, eventTypes } = this.storageSettings.values;
        const logger = this.getLogger();

        const recordedEvents: RecordedEvent[] = [];

        // First, get events from the underlying mixin device
        try {
            const mixinEvents = await this.mixinDevice.getRecordedEvents(options);
            recordedEvents.push(...mixinEvents);
        } catch (e) {
            logger.debug('Error getting events from mixin device', e);
        }

        // If no camera configured, return only mixin events
        if (!cameraName) {
            logger.log('Camera name not set');
            return recordedEvents;
        }

        try {
            const service = `events`;

            const params: any = {
                camera: cameraName,
                limit: options?.count ?? 10000,
            };

            // Add time filters if specified
            if (options?.startTime !== undefined) {
                params.after = options.startTime / 1000;
            }
            if (options?.endTime !== undefined) {
                params.before = options.endTime / 1000;
            }

            const res = await baseFrigateApi<FrigateVideoClip[]>({
                apiUrl: this.plugin.plugin.storageSettings.values.serverUrl,
                service,
                params
            });

            const events = res.data || [];

            // Filter by event types if configured
            const filteredEvents = events.filter(event => {
                // Filter false positives
                if (event.false_positive) {
                    return false;
                }

                // Filter by event type (if configured)
                // Note: Frigate doesn't directly expose 'new'/'update'/'end' type in events API
                // So we only filter by presence of snapshot/clip
                if (!event.has_snapshot) {
                    return false;
                }

                // Filter only object type events
                if (event.data?.type !== 'object') {
                    return false;
                }

                return true;
            });

            // Get camera config for input dimensions
            const config = await this.plugin.plugin.getConfiguration();
            const cameraConfig = config?.cameras?.[cameraName];
            const detectWidth = cameraConfig?.detect?.width || 3840;
            const detectHeight = cameraConfig?.detect?.height || 2160;
            const inputDimensions: [number, number] = [detectWidth, detectHeight];

            // Get real inputDimensions from fromMixin first (before processing events)
            const fromMixin = await this.mixinDevice.getRecordedEvents(options);
            let realInputDimensions: [number, number] | undefined;
            for (const event of fromMixin) {
                if (event.details?.eventInterface === 'ObjectDetector' && event.data?.inputDimensions) {
                    const dims = event.data.inputDimensions;
                    if (Array.isArray(dims) && dims.length >= 2 && dims[0] > 0 && dims[1] > 0) {
                        realInputDimensions = [dims[0], dims[1]];
                        break;
                    }
                }
            }

            // Use real inputDimensions if found, otherwise use detect dimensions
            const finalInputDimensions: [number, number] = realInputDimensions || inputDimensions;
            const scaleX = realInputDimensions ? realInputDimensions[0] / detectWidth : 1;
            const scaleY = realInputDimensions ? realInputDimensions[1] / detectHeight : 1;

            // Get box extension percentage from settings (default 10%)
            const boxExtensionPercent = parseFloat(this.storageSettings.values.boxExtensionPercent || '10') || 10;
            const extensionFactor = boxExtensionPercent / 100;

            // Convert to RecordedEvent
            // Format similar to ObjectDetector events from fromMixin
            const recordedEvents = filteredEvents.map(event => {
                const eventTime = event.start_time * 1000;
                const timestamp = Math.trunc(eventTime);

                // Helper function to convert normalized Frigate box [xMin, yMin, width, height] to Scrypted format
                // and extend it by the configured percentage, ensuring it doesn't exceed image bounds
                const convertNormalizedBox = (box: number[] | null | undefined): [number, number, number, number] | undefined => {
                    if (!box || !Array.isArray(box) || box.length < 4) {
                        return undefined;
                    }
                    const [xMinNorm, yMinNorm, widthNorm, heightNorm] = box;

                    // Convert normalized to detect pixel coordinates
                    const xDetect = xMinNorm * detectWidth;
                    const yDetect = yMinNorm * detectHeight;
                    const wDetect = widthNorm * detectWidth;
                    const hDetect = heightNorm * detectHeight;

                    // Scale to real inputDimensions if available
                    let x = Math.round(xDetect * scaleX);
                    let y = Math.round(yDetect * scaleY);
                    let w = Math.round(wDetect * scaleX);
                    let h = Math.round(hDetect * scaleY);

                    // Extend the box by the configured percentage
                    const extensionX = Math.round(w * extensionFactor);
                    const extensionY = Math.round(h * extensionFactor);

                    // Extend x and y (move top-left corner up and left)
                    x = Math.max(0, x - extensionX);
                    y = Math.max(0, y - extensionY);

                    // Extend width and height (extend bottom-right corner down and right)
                    w = w + (2 * extensionX);
                    h = h + (2 * extensionY);

                    // Ensure the box doesn't exceed image bounds
                    const maxX = finalInputDimensions[0];
                    const maxY = finalInputDimensions[1];

                    // Clamp width and height to not exceed image bounds
                    if (x + w > maxX) {
                        w = maxX - x;
                    }
                    if (y + h > maxY) {
                        h = maxY - y;
                    }

                    // Ensure width and height are positive
                    w = Math.max(0, w);
                    h = Math.max(0, h);

                    return [x, y, w, h];
                };

                // Frigate box is normalized (0-1) in event.data.box format [xMin, yMin, width, height]
                const boundingBox = convertNormalizedBox(event.data?.box || event.box);

                const mappedClassName = detectionClassesDefaultMap[event.label] || event.label;

                // Build detections array with only the main object detection
                const detections: ObjectDetectionResult[] = [];

                // Add the main object detection
                const mainDetection: ObjectDetectionResult = {
                    className: mappedClassName.toLowerCase(), // Use lowercase like in fromMixin
                    score: event.data?.score || event.top_score || 1,
                    boundingBox: boundingBox || [0, 0, 0, 0],
                };

                // Add id if available (from event.id or generate one)
                const detectionId = event.id.split('-')[1] || event.id.split('.').pop() || 'unknown';
                mainDetection.id = detectionId;

                // Add clipped if box is at edges (check against final inputDimensions)
                if (boundingBox) {
                    const [x, y, width, height] = boundingBox;
                    if (x <= 0 || y <= 0 || x + width >= finalInputDimensions[0] || y + height >= finalInputDimensions[1]) {
                        mainDetection.clipped = true;
                    }
                }

                // Add movement info
                const endTime = event.end_time ? event.end_time * 1000 : undefined;
                mainDetection.movement = {
                    firstSeen: timestamp,
                    lastSeen: endTime || timestamp,
                    moving: event.data?.type === 'object' ? true : false,
                };

                detections.push(mainDetection);

                const recordedEvent: RecordedEvent = {
                    details: {
                        eventId: event.id,
                        eventInterface: 'ObjectDetector',
                        eventTime: eventTime,
                    },
                    data: {
                        timestamp: timestamp,
                        detections: detections,
                        inputDimensions: finalInputDimensions,
                        detectionId: event.id,
                    },
                };

                return recordedEvent;
            });

            // Sort by eventTime (most recent first)
            const sortedEvents = sortBy(recordedEvents, (e: any) => e.details?.eventTime || 0).reverse();

            // Limit if specified
            const limitedEvents = options?.count !== undefined
                ? sortedEvents.slice(0, options.count)
                : sortedEvents;

            logger.debug('getRecordedEvents', JSON.stringify({
                options,
                fetchedCount: filteredEvents.length,
                returnedCount: limitedEvents.length,
                detectDimensions: [detectWidth, detectHeight],
                realInputDimensions,
                scaleX,
                scaleY,
            }));

            // Combine: keep MotionSensor events from fromMixin, add our ObjectDetector events
            const motionEvents = fromMixin.filter((e: any) => e.details?.eventInterface === 'MotionSensor');
            const combinedEvents = [...motionEvents, ...limitedEvents];

            // Sort all events by eventTime (most recent first)
            const allEvents = sortBy(combinedEvents, (e: any) => e.details?.eventTime || 0).reverse();

            logger.log('result', JSON.stringify({
                fromMixin,
                allEvents,
                filteredEvents
            }));

            return allEvents;
        } catch (e) {
            logger.error('Error in getRecordedEvents', e);
            return [];
        }
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

    getLogger() {
        if (!this.logger) {
            this.logger = getBaseLogger({
                console: this.console,
                storage: this.storageSettings,
            });
        }

        return this.logger;
    }
}

