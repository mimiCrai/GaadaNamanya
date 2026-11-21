import {
    DISTANCE_TOLERANCE_KM,
    EARTH_RADIUS_KM,
    GRID_CELL_DEG,
    LINK_DISTANCE_KM,
    LINK_WINDOW_MS,
} from '../constants/fire';
import { GeoPoint } from '../types/fire';

const RAD = Math.PI / 180;
const KM_PER_DEG = EARTH_RADIUS_KM * RAD;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isLinked(a: GeoPoint, b: GeoPoint): boolean {
    return (
        Math.abs(a.eventTimeMs - b.eventTimeMs) <= LINK_WINDOW_MS &&
        haversineKm(a.lat, a.lon, b.lat, b.lon) <= LINK_DISTANCE_KM + DISTANCE_TOLERANCE_KM
    );
}

export const cellIndex = (degrees: number): number => Math.floor(degrees / GRID_CELL_DEG);
export const cellKey = (row: number, col: number): string => `${row}:${col}`;
export const cellHeightKm = (): number => GRID_CELL_DEG * KM_PER_DEG;
export const cellWidthKm = (latitude: number): number =>
    GRID_CELL_DEG * KM_PER_DEG * Math.cos(Math.min(89.9, Math.abs(latitude)) * RAD);

// Longitude cells to scan on each side; widened where cells are narrower than the link distance.
export const lonRing = (latitude: number): number =>
    Math.max(1, Math.ceil(LINK_DISTANCE_KM / cellWidthKm(Math.abs(latitude) + 2 * GRID_CELL_DEG)));

export function neighborCells(lat: number, lon: number): string[] {
    const row = cellIndex(lat);
    const col = cellIndex(lon);
    const ring = lonRing(lat);
    const cells: string[] = [];
    for (let r = row - 1; r <= row + 1; r++) {
        for (let c = col - ring; c <= col + ring; c++) cells.push(cellKey(r, c));
    }
    return cells;
}
