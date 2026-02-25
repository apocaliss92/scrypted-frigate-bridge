import { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { join } from "path";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin from "./main";
import { FRIGATE_EVENTS_RECORDER_INTERFACE } from "./utils";
import { FrigateBridgeEventsRecorderMixin } from "./frigateEventsRecorderMixin";

export default class FrigateBridgeEventsRecorder extends ScryptedDeviceBase implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
        logLevel: {
            ...logLevelSetting,
        },
        eventsStoragePath: {
            title: "Events storage directory",
            type: "string",
            description: "Base directory where event JSON files are stored (physical path on the host, e.g. /data/frigate-events). Each camera uses a subfolder named by camera id. Leave empty for default: plugin volume under 'events'.",
            defaultValue: "",
            placeholder: "(default: plugin volume/events)",
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, FrigateBridgeEventsRecorderMixin> = {};
    plugin: FrigateBridgePlugin;
    logger: Console;

    constructor(nativeId: string, plugin: FrigateBridgePlugin) {
        super(nativeId);
        this.plugin = plugin;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
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

    async getSettings() {
        try {
            const settings = await this.storageSettings.getSettings();
            return settings;
        } catch (e) {
            this.getLogger().log('Error in getSettings', e);
            return [];
        }
    }

    /** Base path for events storage; each mixin uses this + camera id. */
    getEventsStorageBasePath(): string {
        const custom = this.storageSettings.values.eventsStoragePath?.trim();
        if (custom) return custom;
        const base = process.env.SCRYPTED_PLUGIN_VOLUME;
        return base ? join(base, "events") : "";
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        if ((type === ScryptedDeviceType.Camera || type === ScryptedDeviceType.Doorbell) &&
            (interfaces.includes(ScryptedInterface.VideoCamera) || interfaces.includes(ScryptedInterface.Camera))) {
            return [
                ScryptedInterface.Settings,
                ScryptedInterface.EventRecorder,
                FRIGATE_EVENTS_RECORDER_INTERFACE
            ];
        }

        return undefined;
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new FrigateBridgeEventsRecorderMixin({
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Frigate Events Recorder',
            groupKey: 'frigateEventsRecorder',
        }, this)
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }
}

