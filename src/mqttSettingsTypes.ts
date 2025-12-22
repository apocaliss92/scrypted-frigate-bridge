export interface FrigateActiveTotalCounts {
    active: number;
    total: number;
}

/**
 * Key: object name (e.g. person, car, all)
 */
export type FrigateObjectCountsMap = Record<string, FrigateActiveTotalCounts>;

/**
 * Key: zone name (or camera name, depending on usage)
 */
export type FrigateZoneObjectCountsMap = Record<string, FrigateObjectCountsMap>;

/** Settings shape for ObjectDetectorMixin.storageSettings.values.zoneActiveObjectMap */
export type CameraZoneActiveObjectMapSetting = FrigateZoneObjectCountsMap;

/** Settings shape for ObjectDetectorMixin.storageSettings.values.activeObjects */
export type CameraActiveObjectsSetting = FrigateObjectCountsMap;
