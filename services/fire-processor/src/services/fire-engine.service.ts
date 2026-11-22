import { LINK_WINDOW_MS, SNAPSHOT_VERSION } from '../constants/fire';
import { parseDecimal } from '../libs/decimal';
import { detectionKeyOf, detectionTimeMs, parseLogRecord } from '../libs/feed-parser';
import { FireGraph } from '../libs/fire-graph';
import { FireRegistry } from '../libs/fire-registry';
import { mapFire } from '../libs/hazard-mapper';
import { defaultProvinces, ProvinceIndex } from '../libs/province-index';
import {
    Detection,
    DetectionInput,
    DetectionKind,
    EngineCounters,
    EngineSnapshot,
    FireChange,
    LateDetection,
    ProcessOutcome,
    ProcessResult,
    RawLogRecord,
    StoredDetection,
    WildfireHazard,
} from '../types/fire';
import { isoSeconds } from '../util/format';

export interface RestoreOptions {
    configuredAllowedLatenessMs?: number;
    provinces?: ProvinceIndex;
}

const emptyCounters = (): EngineCounters => ({
    records: 0,
    detections_received: 0,
    duplicates: 0,
    updates: 0,
    updates_unknown: 0,
    updates_after_retract: 0,
    retracts: 0,
    retracts_unknown: 0,
    retracts_repeated: 0,
    late: 0,
    heartbeats: 0,
    unprocessed: 0,
    invalid: 0,
    stale_offsets: 0,
});

const result = (
    offset: number | null,
    outcome: ProcessOutcome,
    changes: FireChange[] = [],
    late: LateDetection | null = null,
    invalidReason: string | null = null
): ProcessResult => ({ offset, outcome, changes, late, invalidReason });

// Event-time fire processor: applies satellite.raw records in feed-offset order, watermark driven by heartbeats.
export class FireEngine {
    readonly graph = new FireGraph();
    readonly fires = new FireRegistry((key) => this.graph.get(key)!.eventTimeMs);
    private watermarkMs = -Infinity;
    private lastVirtualNowMs: number | null = null;
    private lastOffset = -1;
    private lastKafkaOffset: string | null = null;
    private readonly lateKeys = new Set<string>();
    private counters = emptyCounters();

    constructor(
        readonly allowedLatenessMs: number,
        private readonly provinces: ProvinceIndex = defaultProvinces()
    ) {
        if (!Number.isSafeInteger(allowedLatenessMs) || allowedLatenessMs < 0) {
            throw new RangeError('allowedLatenessMs must be a non-negative integer');
        }
    }

    get processedOffset(): number {
        return this.lastOffset;
    }

    get kafkaOffset(): string | null {
        return this.lastKafkaOffset;
    }

    get watermark(): number {
        return this.watermarkMs;
    }

    get virtualNow(): number | null {
        return this.lastVirtualNowMs;
    }

    process(record: RawLogRecord, kafkaOffset?: string): ProcessResult {
        if (kafkaOffset !== undefined) this.lastKafkaOffset = kafkaOffset;
        const event = parseLogRecord(record);
        if (event.offset === null) {
            this.counters.invalid++;
            return result(null, 'invalid', [], null, event.type === 'invalid' ? event.reason : null);
        }
        if (event.offset <= this.lastOffset) {
            this.counters.stale_offsets++;
            return result(event.offset, 'stale_offset');
        }
        this.lastOffset = event.offset;
        this.counters.records++;

        switch (event.type) {
            case 'heartbeat':
                this.counters.heartbeats++;
                this.lastVirtualNowMs = event.virtualNowMs;
                this.watermarkMs = Math.max(this.watermarkMs, event.virtualNowMs - this.allowedLatenessMs);
                return result(event.offset, 'heartbeat');
            case 'unprocessed':
                this.counters.unprocessed++;
                return result(event.offset, 'unprocessed');
            case 'invalid':
                this.counters.invalid++;
                return result(event.offset, 'invalid', [], null, event.reason);
            case 'detection':
                this.counters.detections_received++;
                return this.addNew(event.offset, event.detection, 'detection', event.receivedAt);
            case 'update':
                this.counters.updates++;
                return this.update(event.offset, event.detection, event.receivedAt);
            case 'retract':
                this.counters.retracts++;
                return this.retract(event.offset, event.key);
        }
    }

    hazard(id: string): WildfireHazard | null {
        const fire = this.fires.get(id);
        if (!fire) return null;
        const members = fire.members.map((key) => this.graph.get(key)!);
        return mapFire(fire, members, this.provinces);
    }

    hazards(): WildfireHazard[] {
        return this.fires.allSorted().map((fire) => this.hazard(fire.id)!);
    }

    stats() {
        return {
            last_offset: this.lastOffset,
            last_kafka_offset: this.lastKafkaOffset,
            watermark: Number.isFinite(this.watermarkMs) ? isoSeconds(this.watermarkMs) : null,
            last_virtual_now: this.lastVirtualNowMs === null ? null : isoSeconds(this.lastVirtualNowMs),
            allowed_lateness_minutes: this.allowedLatenessMs / 60_000,
            ...this.graph.counts(),
            fires: this.fires.size,
            final_fires: this.fires.countFinal(this.watermarkMs, LINK_WINDOW_MS),
            late_detections: this.counters.late,
            counters: { ...this.counters },
        };
    }

    snapshot(): EngineSnapshot {
        return {
            v: SNAPSHOT_VERSION,
            allowed_lateness_ms: this.allowedLatenessMs,
            watermark_ms: Number.isFinite(this.watermarkMs) ? this.watermarkMs : null,
            last_virtual_now_ms: this.lastVirtualNowMs,
            last_offset: this.lastOffset,
            last_kafka_offset: this.lastKafkaOffset,
            counters: { ...this.counters },
            detections: this.graph.allSorted().map(toStored),
            fires: this.fires.snapshot(),
            late_keys: [...this.lateKeys].sort(),
        };
    }

    // The snapshot's allowed lateness wins over configuration so replayed "late" decisions stay identical.
    static restore(
        snapshot: EngineSnapshot,
        options: RestoreOptions = {}
    ): { engine: FireEngine; latenessMismatch: boolean } {
        if (snapshot.v !== SNAPSHOT_VERSION) throw new Error(`unsupported fire snapshot version ${String(snapshot.v)}`);
        const engine = new FireEngine(snapshot.allowed_lateness_ms, options.provinces);
        engine.watermarkMs = snapshot.watermark_ms ?? -Infinity;
        engine.lastVirtualNowMs = snapshot.last_virtual_now_ms;
        engine.lastOffset = snapshot.last_offset;
        engine.lastKafkaOffset = snapshot.last_kafka_offset;
        engine.counters = { ...emptyCounters(), ...snapshot.counters };
        snapshot.late_keys.forEach((key) => engine.lateKeys.add(key));
        engine.graph.restore(snapshot.detections.map(fromStored));
        engine.fires.restore(snapshot.fires);
        const configured = options.configuredAllowedLatenessMs;
        return { engine, latenessMismatch: configured !== undefined && configured !== snapshot.allowed_lateness_ms };
    }

    private update(offset: number, input: DetectionInput, receivedAt: string | null): ProcessResult {
        const previous = this.graph.get(input.key);
        if (!previous) {
            if (!this.lateKeys.has(input.key)) this.counters.updates_unknown++;
            return this.addNew(offset, input, 'update', receivedAt);
        }
        if (previous.retracted) {
            this.counters.updates_after_retract++;
            return result(offset, 'ignored');
        }
        return this.applyPut(offset, {
            ...previous,
            confidence: input.confidence,
            frpText: input.frpText,
            frp: input.frp,
            lastOffset: offset,
        });
    }

    private retract(offset: number, key: string): ProcessResult {
        const previous = this.graph.get(key);
        if (!previous) {
            this.counters.retracts_unknown++;
            return result(offset, 'ignored');
        }
        if (previous.retracted) {
            this.counters.retracts_repeated++;
            return result(offset, 'ignored');
        }
        return this.applyPut(offset, { ...previous, retracted: true, lastOffset: offset });
    }

    private addNew(
        offset: number,
        input: DetectionInput,
        kind: DetectionKind,
        receivedAt: string | null
    ): ProcessResult {
        const isLateKey = this.lateKeys.has(input.key);
        if (kind === 'update' && isLateKey) return this.markLate(offset, input, kind, receivedAt);
        if (isLateKey || this.graph.get(input.key)) {
            this.counters.duplicates++;
            return result(offset, 'duplicate');
        }
        if (input.eventTimeMs < this.watermarkMs) return this.markLate(offset, input, kind, receivedAt);
        return this.applyPut(offset, { ...input, retracted: false, firstOffset: offset, lastOffset: offset });
    }

    private markLate(
        offset: number,
        input: DetectionInput,
        kind: DetectionKind,
        receivedAt: string | null
    ): ProcessResult {
        this.lateKeys.add(input.key);
        this.counters.late++;
        return result(offset, 'late', [], {
            offset,
            detection_key: input.key,
            kind,
            event_time: isoSeconds(input.eventTimeMs),
            watermark: isoSeconds(this.watermarkMs),
            received_at: receivedAt,
        });
    }

    private applyPut(offset: number, next: Detection): ProcessResult {
        const change = this.graph.put(next);
        return { ...result(offset, 'applied', this.fires.apply(change, offset)), detectionKey: next.key };
    }
}

const toStored = (d: Detection): StoredDetection => [
    d.satellite,
    d.acqDate,
    d.acqTime,
    d.latText,
    d.lonText,
    d.confidence,
    d.frpText,
    d.retracted ? 1 : 0,
    d.firstOffset,
    d.lastOffset,
];

function fromStored(stored: StoredDetection): Detection {
    const [satellite, acqDate, acqTime, latText, lonText, confidence, frpText, retracted, firstOffset, lastOffset] =
        stored;
    const eventTimeMs = detectionTimeMs(acqDate, acqTime);
    const frp = parseDecimal(frpText);
    if (eventTimeMs === null || frp === null) throw new Error(`corrupt detection in snapshot: ${satellite}|${acqDate}`);
    const parts = { satellite, acqDate, acqTime, latText, lonText };
    return {
        key: detectionKeyOf(parts),
        ...parts,
        lat: Number(latText),
        lon: Number(lonText),
        eventTimeMs,
        confidence,
        frpText,
        frp,
        retracted: retracted === 1,
        firstOffset,
        lastOffset,
    };
}
