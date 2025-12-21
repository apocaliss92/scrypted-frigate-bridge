import { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin from "./main";
import { FRIGATE_VIDEOCLIPS_INTERFACE } from "./utils";
import { FrigateBridgeVideoclipsMixin } from "./videoclipsMixin";

export default class FrigateBridgeVideoclips extends ScryptedDeviceBase implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
        logLevel: {
            ...logLevelSetting,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, FrigateBridgeVideoclipsMixin> = {};
    plugin: FrigateBridgePlugin;
    logger: Console;

    constructor(nativeId: string, plugin: FrigateBridgePlugin) {
        super(nativeId);
        this.plugin = plugin;
    }

    // async maybeEnableMixin(device: ScryptedDevice) {
    // if (device.pluginId === pluginId && device.nativeId !== birdseyeCameraNativeId) {
    //     super.maybeEnableMixin(device);
    // } else {
    //     return;
    // }
    // }

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

