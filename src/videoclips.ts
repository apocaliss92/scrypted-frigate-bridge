import { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { BasePlugin, getBaseLogger } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin from "./main";
import { FRIGATE_VIDEOCLIPS_INTERFACE } from "./utils";
import { FrigateBridgeVideoclipsMixin } from "./videoclipsMixin";

export default class FrigateBridgeVideoclips extends BasePlugin implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
        debug: {
            title: 'Log debug messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, FrigateBridgeVideoclipsMixin> = {};
    plugin: FrigateBridgePlugin;

    constructor(nativeId: string, plugin: FrigateBridgePlugin) {
        super(nativeId, {
            pluginFriendlyName: 'Frigate Videoclips',
        });
        this.plugin = plugin;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    public getLogger(device?: ScryptedDeviceBase) {
        const newLogger = getBaseLogger({
            console: device ? this.currentMixinsMap[device.id].console : this.console,
            storage: this.storageSettings,
            friendlyName: `scrypted_frigate_videoclips_${device ? device?.id : 'device'}`
        });

        return newLogger;
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

    async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
        if ((type === ScryptedDeviceType.Camera || type === ScryptedDeviceType.Doorbell) &&
            (interfaces.includes(ScryptedInterface.VideoCamera) || interfaces.includes(ScryptedInterface.Camera))) {
            return [
                ScryptedInterface.Settings,
                ScryptedInterface.VideoClips,
                FRIGATE_VIDEOCLIPS_INTERFACE
            ];
        }

        return undefined;
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new FrigateBridgeVideoclipsMixin({
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Frigate Videoclips',
            groupKey: 'frigateVideoclips',
        }, this)
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }
}

