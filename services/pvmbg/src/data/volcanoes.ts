import { AlertLevel } from '../types/contract';


export const VOLCANO_STARTING_LEVELS: Readonly<Record<string, AlertLevel>> = {
    MERAPI: 'Siaga',
    SEMERU: 'Waspada',
    ANAK_KRAKATAU: 'Awas',
    SINABUNG: 'Waspada',
    MARAPI: 'Normal',
};

export const VOLCANO_IDS: readonly string[] = Object.keys(VOLCANO_STARTING_LEVELS);
