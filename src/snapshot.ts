import { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, SettingValue, WritableDeviceState } from "@scrypted/sdk";
import { StorageSettings, StorageSettingsDict } from "@scrypted/sdk/storage-settings";
import { getBaseLogger, logLevelSetting } from '../../scrypted-apocaliss-base/src/basePlugin';
import FrigateBridgePlugin from "./main";
import { FRIGATE_SNAPSHOT_INTERFACE } from "./utils";
import { FrigateBridgeSnapshotMixin } from "./snapshotMixin";

export default class FrigateBridgeSnapshot extends ScryptedDeviceBase implements MixinProvider {
    initStorage: StorageSettingsDict<string> = {
        logLevel: {
            ...logLevelSetting,
        },
    };
    storageSettings = new StorageSettings(this, this.initStorage);
    currentMixinsMap: Record<string, FrigateBridgeSnapshotMixin> = {};
    plugin: FrigateBridgePlugin;

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
                ScryptedInterface.Camera,
                FRIGATE_SNAPSHOT_INTERFACE
            ];
        }

        return undefined;
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        return new FrigateBridgeSnapshotMixin({
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
            group: 'Frigate Snapshot',
            groupKey: 'frigateSnapshot',
        }, this)
    }

    async releaseMixin(id: string, mixinDevice: any): Promise<void> {
        await mixinDevice.release();
    }
}

