export interface PollRequestOptions {
    since?: Date;
    correlationId: string;
}

export interface SeismicEvent {
    event_id: string;
    magnitude: number;
    depth_km: number;
    epicenter_lat: number;
    epicenter_lon: number;
    region_name: string;
    occurred_at: string;
    potential_tsunami: boolean;
}

export interface TsunamiWarning {
    warning_id: string;
    related_event_id: string;
    threat_level: 'Waspada' | 'Siaga' | 'Awas';
    affected_zones: string[];
    estimated_arrival: string;
}

export interface VolcanicReport {
    report_id: string;
    volcano_id: string;
    alert_level: 'Normal' | 'Waspada' | 'Siaga' | 'Awas';
    eruption_count_24h: number;
    ash_column_height_m: number;
    reported_at: string;
    [field: string]: unknown;
}

export function getRecordsFromResponse<T>(payload: unknown): T[] {
    if (Array.isArray(payload)) {
        return payload as T[];
    }

    if (typeof payload === 'object' && payload !== null && 'data' in payload && Array.isArray(payload.data)) {
        return payload.data as T[];
    }

    throw new Error('Source response must be an array or an object with a data array');
}
