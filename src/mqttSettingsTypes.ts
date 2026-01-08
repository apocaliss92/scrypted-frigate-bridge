export interface FrigateActiveTotalCounts {
    active: number;
    total: number;
}

/**
 * Key: object name (e.g. person, car, all)
 */
export type FrigateObjectCountsMap = Record<string, FrigateActiveTotalCounts>;
