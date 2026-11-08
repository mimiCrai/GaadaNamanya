export enum HazardSource {
    Bmkg = 'BMKG',
    Pvmbg = 'PVMBG',
    Satelit = 'SATELIT',
    SensorPantai = 'SENSOR_PANTAI',
}

export enum HazardType {
    Seismic = 'SEISMIC',
    Volcanic = 'VOLCANIC',
    Wildfire = 'WILDFIRE',
    Coastal = 'COASTAL',
}

export enum HazardSeverity {
    Normal = 'NORMAL',
    Waspada = 'WASPADA',
    Siaga = 'SIAGA',
    Awas = 'AWAS',
}

export const hazardEvents = 'hazard_events';

export interface HazardEvent {
    hazardId: string;
    source: HazardSource;
    sourceRefId: string;
    hazardType: HazardType;
    severity: HazardSeverity;
    areaName: string;
    latitude: number;
    longitude: number;
    occurredAt: Date;
    ingestedAt: Date;
    attributes: Record<string, unknown>;
}

export type NewHazardEvent = HazardEvent;
