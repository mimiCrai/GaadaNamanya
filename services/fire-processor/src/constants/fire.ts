import { Decimal, Severity } from '../types/fire';

export const EARTH_RADIUS_KM = 6371.0;
export const LINK_DISTANCE_KM = 1.0;
export const DISTANCE_TOLERANCE_KM = 1e-9;
export const LINK_WINDOW_MS = 360 * 60_000;
export const GRID_CELL_DEG = 0.01;

export const MIN_FIRE_SIZE = 2;
export const CENTROID_SCALE = 6;
export const SNAPSHOT_VERSION = 1;

// Checked in order; anything below the last level is WASPADA.
export const SEVERITY_LEVELS: readonly { severity: Severity; minCount: number; minFrp: Decimal }[] = [
    { severity: 'AWAS', minCount: 20, minFrp: { units: 100n, scale: 0 } },
    { severity: 'SIAGA', minCount: 6, minFrp: { units: 30n, scale: 0 } },
];
