import sdk, { EventRecorder, ObjectsDetected, RecordedEvent, RecordedEventOptions, ScryptedInterface, Setting, Settings, SettingValue } from "@scrypted/sdk";
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from "@scrypted/sdk/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { sortBy } from "lodash";
import { join } from "path";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgeEventsRecorder from "./frigateEventsRecorder";
import { ensureMixinsOrder, initFrigateMixin } from "./utils";

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
        eventsRetentionDays: {
            title: 'Events retention (days)',
            type: 'number',
            description: 'Number of days to keep events (MotionSensor and ObjectDetector) in JSON files (default: 30)',
            defaultValue: '30',
            immediate: true,
        },
    });

    logger: Console;
    private eventsDbPath: string;
    private eventsBuffer: RecordedEvent[] = [];
    private bufferWriteInterval: NodeJS.Timeout | null = null;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private motionListener: any = null;
    private detectionListener: any = null;

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

        // Initialize events DB path using SCRYPTED_PLUGIN_VOLUME and camera ID
        const basePath = process.env.SCRYPTED_PLUGIN_VOLUME;
        this.eventsDbPath = join(basePath, 'events', this.id);
        try {
            await mkdir(this.eventsDbPath, { recursive: true });
        } catch (e) {
            logger.error('Error creating events DB directory', e);
        }

        // Start event listeners
        this.startEventListeners();

        // Start buffer write interval (every 5 seconds)
        this.bufferWriteInterval = setInterval(() => {
            this.flushEventsBuffer().catch(e => logger.error('Error flushing events buffer', e));
        }, 5000);

        // Start cleanup interval (every 10 minutes)
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldEvents().catch(e => logger.error('Error cleaning up old events', e));
        }, 10 * 60 * 1000);

        // Initial cleanup
        this.cleanupOldEvents().catch(logger.error);
    }

    private startEventListeners() {
        const logger = this.getLogger();

        // Listen to MotionSensor events
        this.motionListener = sdk.systemManager.listenDevice(this.id, {
            event: ScryptedInterface.MotionSensor,
        }, async (_, eventDetails, data) => {
            const now = Date.now();

            const recordedEvent: RecordedEvent = {
                details: {
                    eventId: eventDetails.eventId,
                    eventInterface: 'MotionSensor',
                    eventTime: eventDetails.eventTime ?? now,
                },
                data
            };

            this.eventsBuffer.push(recordedEvent);
        });

        // Listen to ObjectDetector events
        this.detectionListener = sdk.systemManager.listenDevice(this.id, {
            event: ScryptedInterface.ObjectDetector,
        }, async (_, eventDetails, data) => {
            const detect: ObjectsDetected = data;
            const now = Date.now();

            const detections = (detect.detections || []).filter((d: any) => {
                return !!d.movement?.moving;
            });

            // Only save if there are detections with moving: true
            if (detections.length === 0) {
                return;
            }

            const recordedEvent: RecordedEvent = {
                details: {
                    eventId: eventDetails.eventId,
                    eventInterface: 'ObjectDetector',
                    eventTime: now,
                },
                data: {
                    timestamp: detect.timestamp || now,
                    detections: detections,
                    inputDimensions: detect.inputDimensions,
                    detectionId: detect.detectionId,
                },
            };

            this.eventsBuffer.push(recordedEvent);
        });

        logger.log('Event listeners started');
    }

    private async flushEventsBuffer(): Promise<void> {
        if (this.eventsBuffer.length === 0) {
            return;
        }

        const logger = this.getLogger();
        const eventsToWrite = [...this.eventsBuffer];
        this.eventsBuffer = [];

        // Group events by date
        const eventsByDate = new Map<string, RecordedEvent[]>();

        for (const event of eventsToWrite) {
            const eventDate = new Date(event.details?.eventTime || Date.now());
            const dateStr = eventDate.toISOString().split('T')[0]; // YYYY-MM-DD

            if (!eventsByDate.has(dateStr)) {
                eventsByDate.set(dateStr, []);
            }
            eventsByDate.get(dateStr)!.push(event);
        }

        // Write events to their respective date files
        for (const [dateStr, events] of eventsByDate.entries()) {
            try {
                const filePath = this.getEventsFilePath(new Date(dateStr));
                const tempFilePath = `${filePath}.tmp`;

                // Load existing events
                const existingEvents = await this.loadEventsFromFile(filePath);

                // Merge with existing events, avoiding duplicates
                const eventIds = new Set(existingEvents.map((e: any) => e.details?.eventId));
                const newEvents = events.filter(e => !eventIds.has(e.details?.eventId));

                if (newEvents.length > 0) {
                    const allEvents = [...existingEvents, ...newEvents];
                    const sorted = sortBy(allEvents, (e: any) => e.details?.eventTime || 0);
                    
                    // Write to temporary file first (atomic write)
                    await writeFile(tempFilePath, JSON.stringify(sorted, null, 2), 'utf-8');
                    
                    // Rename temp file to final file (atomic operation)
                    await rename(tempFilePath, filePath);
                    
                    logger.debug(`Flushed ${newEvents.length} events to ${dateStr}.json`);
                }
            } catch (e) {
                logger.error(`Error writing events to file for date ${dateStr}`, e);
                // Try to clean up temp file if it exists
                try {
                    const filePath = this.getEventsFilePath(new Date(dateStr));
                    const tempFilePath = `${filePath}.tmp`;
                    await unlink(tempFilePath);
                } catch (cleanupError) {
                    // Ignore cleanup errors
                }
            }
        }
    }

    private getEventsFilePath(date: Date): string {
        const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
        return join(this.eventsDbPath, `${dateStr}.json`);
    }

    private async loadEventsFromFile(filePath: string): Promise<RecordedEvent[]> {
        try {
            const content = await readFile(filePath, 'utf-8');
            const events = JSON.parse(content);
            return Array.isArray(events) ? events : [];
        } catch (e) {
            return [];
        }
    }

    private async saveEventToFile(event: RecordedEvent): Promise<void> {
        const eventDate = new Date(event.details?.eventTime || Date.now());
        const filePath = this.getEventsFilePath(eventDate);
        const tempFilePath = `${filePath}.tmp`;

        try {
            const existingEvents = await this.loadEventsFromFile(filePath);

            const eventId = event.details?.eventId;
            if (eventId && !existingEvents.find((e: any) => e.details?.eventId === eventId)) {
                existingEvents.push(event);

                // Sort by eventTime
                const sorted = sortBy(existingEvents, (e: any) => e.details?.eventTime || 0);

                // Write to temporary file first (atomic write)
                await writeFile(tempFilePath, JSON.stringify(sorted, null, 2), 'utf-8');
                
                // Rename temp file to final file (atomic operation)
                await rename(tempFilePath, filePath);
            }
        } catch (e) {
            this.getLogger().error('Error saving event to file', e);
            // Try to clean up temp file if it exists
            try {
                await unlink(tempFilePath);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
        }
    }

    private async loadEventsFromDateRange(startDate: Date, endDate: Date): Promise<RecordedEvent[]> {
        const events: RecordedEvent[] = [];
        const currentDate = new Date(startDate);

        while (currentDate <= endDate) {
            const filePath = this.getEventsFilePath(currentDate);
            const dayEvents = await this.loadEventsFromFile(filePath);
            events.push(...dayEvents);

            // Move to next day
            currentDate.setDate(currentDate.getDate() + 1);
        }

        return events;
    }

    private async cleanupOldEvents(): Promise<void> {
        const retentionDays = parseInt(this.storageSettings.values.eventsRetentionDays || '30') || 30;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

        try {
            const files = await readdir(this.eventsDbPath);
            const logger = this.getLogger();

            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                // Extract date from filename (YYYY-MM-DD.json)
                const dateStr = file.replace('.json', '');
                const fileDate = new Date(dateStr);

                if (fileDate < cutoffDate) {
                    const filePath = join(this.eventsDbPath, file);
                    await unlink(filePath);
                    logger.debug(`Deleted old events file: ${file}`);
                }
            }
        } catch (e) {
            this.getLogger().error('Error cleaning up old events', e);
        }
    }

    async getRecordedEvents(options?: RecordedEventOptions): Promise<RecordedEvent[]> {
        const logger = this.getLogger();
        const recordedEvents: RecordedEvent[] = [];

        // Determine date range
        const startDate = options?.startTime ? new Date(options.startTime) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days
        const endDate = options?.endTime ? new Date(options.endTime) : new Date();

        // Load events from JSON files
        const fileEvents = await this.loadEventsFromDateRange(startDate, endDate);

        // Filter by time range
        const filteredEvents = fileEvents.filter((e: any) => {
            const eventTime = e.details?.eventTime || 0;
            if (options?.startTime && eventTime < options.startTime) return false;
            if (options?.endTime && eventTime > options.endTime) return false;
            return true;
        });

        recordedEvents.push(...filteredEvents);

        // Also include events from buffer that haven't been flushed yet
        const bufferEvents = this.eventsBuffer.filter((e: any) => {
            const eventTime = e.details?.eventTime || 0;
            if (options?.startTime && eventTime < options.startTime) return false;
            if (options?.endTime && eventTime > options.endTime) return false;
            return true;
        });

        recordedEvents.push(...bufferEvents);

        // Sort all events by eventTime (most recent first)
        const sortedEvents = sortBy(recordedEvents, (e: any) => e.details?.eventTime || 0).reverse();

        // Limit if specified
        const limitedEvents = options?.count !== undefined
            ? sortedEvents.slice(0, options.count)
            : sortedEvents;

        logger.debug('getRecordedEvents', JSON.stringify({
            options,
            fileEventsCount: filteredEvents.length,
            bufferEventsCount: bufferEvents.length,
            returnedCount: limitedEvents.length,
        }));

        return limitedEvents;
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

        // If retention days changed, cleanup old files
        if (key === 'eventsRetentionDays') {
            this.cleanupOldEvents().catch(e => this.getLogger().error('Error cleaning up old events', e));
        }
    }

    async release() {
        const logger = this.getLogger();
        logger.info('Releasing mixin');

        // Stop event listeners
        if (this.motionListener) {
            this.motionListener.remove();
            this.motionListener = null;
        }
        if (this.detectionListener) {
            this.detectionListener.remove();
            this.detectionListener = null;
        }

        // Stop intervals
        if (this.bufferWriteInterval) {
            clearInterval(this.bufferWriteInterval);
            this.bufferWriteInterval = null;
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        // Flush remaining events in buffer
        await this.flushEventsBuffer();
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

