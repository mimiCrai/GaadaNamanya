export const hazardTombstones = 'hazard_tombstones';
export const lateDetections = 'late_detections';
export const fireProcessorState = 'fire_processor_state';
export const fireSnapshotBucket = 'fire_snapshots';

export const FIRE_SNAPSHOT_STATE_ID = 'snapshot';
export const FIRE_STATS_STATE_ID = 'stats';

// a deleted HazardEvent remembers its version so a stale upsert cannot bring it back
export interface HazardTombstone {
    _id: string;
    source: string;
    sourceRefId: string;
    version: string;
    deletedAt: Date;
    correlationId: string;
}

// one document per feed offset (_id = "late-<offset>"), first write wins
export interface StoredLateDetection {
    _id: string;
    offset: number;
    detectionKey: string;
    kind: 'detection' | 'update';
    eventTime: Date;
    watermark: Date;
    receivedAt: Date | null;
    storedAt: Date;
    correlationId: string;
}

export interface FireSnapshotPointer {
    _id: typeof FIRE_SNAPSHOT_STATE_ID;
    fileId: string;
    feedOffset: number;
    kafkaOffset: string | null;
    sha256: string;
    sizeBytes: number;
    savedAt: Date;
}

export interface FireStatsState {
    _id: typeof FIRE_STATS_STATE_ID;
    lastOffset: number;
    stats: Record<string, unknown>;
    instanceId: string | null;
    updatedAt: Date;
}
