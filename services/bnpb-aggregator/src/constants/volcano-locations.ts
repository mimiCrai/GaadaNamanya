export interface VolcanoLocation {
    areaName: string;
    latitude: number;
    longitude: number;
}

/**
 * BNPB-owned reference data. PVMBG's `volcano_id` is an external identifier;
 * display name and coordinates are resolved here rather than trusted from a
 * source payload. Keep the PVMBG mock's seeded IDs aligned with these keys.
 */
export const VOLCANO_LOCATIONS: Readonly<Record<string, VolcanoLocation>> = {
    MERAPI: { areaName: 'Gunung Merapi', latitude: -7.5407, longitude: 110.4457 },
    SEMERU: { areaName: 'Gunung Semeru', latitude: -8.108, longitude: 112.922 },
    ANAK_KRAKATAU: { areaName: 'Anak Krakatau', latitude: -6.102, longitude: 105.423 },
    SINABUNG: { areaName: 'Gunung Sinabung', latitude: 3.17, longitude: 98.392 },
    MARAPI: { areaName: 'Gunung Marapi', latitude: -0.381, longitude: 100.473 },
};

export function getVolcanoLocation(volcanoId: string): VolcanoLocation {
    const normalizedId = volcanoId.trim().toUpperCase();
    const location = VOLCANO_LOCATIONS[normalizedId];
    if (!location) {
        throw new Error(`No BNPB volcano location exists for PVMBG volcano_id '${volcanoId}'`);
    }
    return location;
}
