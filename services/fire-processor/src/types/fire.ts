export interface Decimal {
    units: bigint;
    scale: number;
}

export type RawValue =
    { kind: 'string'; value: string; raw: string } | { kind: 'number' | 'literal' | 'object' | 'array'; raw: string };

export type Confidence = 'l' | 'n' | 'h';

export interface GeoPoint {
    lat: number;
    lon: number;
    eventTimeMs: number;
}

export interface DetectionKeyParts {
    satellite: string;
    acqDate: string;
    acqTime: string;
    latText: string;
    lonText: string;
}

export interface DetectionInput extends DetectionKeyParts, GeoPoint {
    key: string;
    confidence: Confidence;
    frpText: string;
    frp: Decimal;
}

export interface Detection extends DetectionInput {
    retracted: boolean;
    firstOffset: number;
    lastOffset: number;
}

export interface RawLogRecord {
    v?: number;
    offset?: unknown;
    kind?: unknown;
    received_at?: unknown;
    data_raw?: unknown;
    virtual_now?: unknown;
    message_id?: unknown;
    reason?: unknown;
}

export type FeedEvent =
    | { type: 'detection' | 'update'; offset: number; receivedAt: string | null; detection: DetectionInput }
    | { type: 'retract'; offset: number; receivedAt: string | null; key: string }
    | { type: 'heartbeat'; offset: number; virtualNowMs: number }
    | { type: 'unprocessed'; offset: number }
    | { type: 'invalid'; offset: number | null; reason: string };

export interface GraphChange {
    before: string[][];
    after: string[][];
}

export interface Fire {
    id: string;
    anchorKey: string;
    members: string[];
    version: number;
    maxEventTimeMs: number;
}

export type FireDeleteReason = 'merged' | 'dissolved';

export type FireChange =
    | { op: 'upsert'; id: string; version: number }
    | { op: 'delete'; id: string; version: number; reason: FireDeleteReason };

export interface StoredFire {
    id: string;
    anchor_key: string;
    members: string[];
    version: number;
}

export type Severity = 'WASPADA' | 'SIAGA' | 'AWAS';

export interface WildfireAttributes {
    detection_count: number;
    satellites: string[];
    max_confidence: 'n' | 'h';
    total_frp_mw: number;
    detection_keys: string[];
}

export interface WildfireHazard {
    source: 'SATELIT';
    source_ref_id: string;
    hazard_type: 'WILDFIRE';
    severity: Severity;
    area_name: string;
    latitude: number;
    longitude: number;
    occurred_at: string;
    attributes: WildfireAttributes;
}

export interface Province {
    name: string;
    latitude: number;
    longitude: number;
}

export type DetectionKind = 'detection' | 'update';

export interface LateDetection {
    offset: number;
    detection_key: string;
    kind: DetectionKind;
    event_time: string;
    watermark: string;
    received_at: string | null;
}

export type ProcessOutcome =
    'applied' | 'duplicate' | 'late' | 'ignored' | 'heartbeat' | 'unprocessed' | 'invalid' | 'stale_offset';

export interface ProcessResult {
    offset: number | null;
    outcome: ProcessOutcome;
    changes: FireChange[];
    late: LateDetection | null;
    invalidReason: string | null;
}

export interface EngineCounters {
    records: number;
    detections_received: number;
    duplicates: number;
    updates: number;
    updates_unknown: number;
    updates_after_retract: number;
    retracts: number;
    retracts_unknown: number;
    retracts_repeated: number;
    late: number;
    heartbeats: number;
    unprocessed: number;
    invalid: number;
    stale_offsets: number;
}

export type StoredDetection = [
    satellite: string,
    acqDate: string,
    acqTime: string,
    latText: string,
    lonText: string,
    confidence: Confidence,
    frpText: string,
    retracted: 0 | 1,
    firstOffset: number,
    lastOffset: number,
];

export interface EngineSnapshot {
    v: 1;
    allowed_lateness_ms: number;
    watermark_ms: number | null;
    last_virtual_now_ms: number | null;
    last_offset: number;
    last_kafka_offset: string | null;
    counters: EngineCounters;
    detections: StoredDetection[];
    fires: StoredFire[];
    late_keys: string[];
}
