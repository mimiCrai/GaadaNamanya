import { inject, injectable } from 'inversify';
import { PVMBG_ENDPOINT, PVMBG_RECORD_KIND, PVMBG_RESPONSE_KIND, VolcanicReportBatch } from '../clients/pvmbg.client';
import { PVMBG_VOLCANIC_FIELDS, volcanicReportSchema } from '../clients/pvmbg.schema';
import { SeismicEvent, TsunamiWarning, VolcanicReport } from '../clients/source-client.types';
import { findVolcanoLocation } from '../constants/volcano-locations';
import { TYPES } from '../constants/types';
import { HazardSeverity, HazardSource, HazardType } from '../db/schema/hazard-events';
import { logger } from '../libs/logger';
import { hazardWritesSupersededTotal } from '../libs/metrics';
import { classifyError, ProcessingError } from '../libs/processing-error';
import { decodeJson, RawRecord, toRawRecords } from '../libs/safe-decode';
import { validateRecord } from '../libs/schema-validation';
import { HazardEventUpsertResult, IHazardEventRepository } from '../repositories/hazard-event.repository';
import { IPendingTsunamiWarningRepository } from '../repositories/pending-tsunami-warning.repository';
import env from '../util/env';
import { LeaseLostError, LeaseToken } from '../db/schema/background-leases';
import { IUnprocessedRecorder } from './unprocessed-recorder.service';
import { IOrderingSequenceRepository } from '../repositories/ordering-sequence.repository';
import { formatReceiveOrder, LEGACY_RECEIVE_ORDER, ReceiveOrder } from '../libs/receive-order';

export interface IHazardEventIngestionService {
    ingestSeismicEvents(events: SeismicEvent[], correlationId: string, lease: LeaseToken): Promise<void>;
    ingestVolcanicBatch(batch: VolcanicReportBatch, correlationId: string, lease: LeaseToken): Promise<void>;
    ingestVolcanicReports(reports: VolcanicReport[], correlationId: string, lease: LeaseToken): Promise<void>;
    ingestTsunamiWarnings(warnings: TsunamiWarning[], correlationId: string, lease: LeaseToken): Promise<void>;

    reprocessVolcanicRecord(
        raw: Buffer,
        correlationId: string,
        lease: LeaseToken,
        ordering: ReceiveOrder | null | undefined
    ): Promise<VolcanicIngestResult>;
    reprocessVolcanicResponse(
        raw: Buffer,
        correlationId: string,
        lease: LeaseToken,
        ordering: ReceiveOrder | null | undefined
    ): Promise<void>;
}

export interface VolcanicIngestResult {
    hazardId: string;
    superseded: boolean;
}

export const PVMBG_RECEIVE_SEQUENCE = 'PVMBG:receive';

export function pvmbgVersion(reportedAt: Date, ordering: ReceiveOrder): string {
    return `${reportedAt.toISOString()}|${formatReceiveOrder(ordering)}`;
}

const PVMBG_RECORD_CONTEXT = { kind: PVMBG_RECORD_KIND, endpoint: PVMBG_ENDPOINT, topic: null };
const PVMBG_RESPONSE_CONTEXT = { kind: PVMBG_RESPONSE_KIND, endpoint: PVMBG_ENDPOINT, topic: null };

@injectable()
export class HazardEventIngestionService implements IHazardEventIngestionService {
    constructor(
        @inject(TYPES.IHazardEventRepository)
        private readonly hazardEventRepository: IHazardEventRepository,
        @inject(TYPES.IPendingTsunamiWarningRepository)
        private readonly pendingTsunamiWarningRepository: IPendingTsunamiWarningRepository,
        @inject(TYPES.IUnprocessedRecorder)
        private readonly unprocessed: IUnprocessedRecorder,
        @inject(TYPES.IOrderingSequenceRepository)
        private readonly sequences: IOrderingSequenceRepository
    ) {}

    async ingestVolcanicBatch(batch: VolcanicReportBatch, correlationId: string, lease: LeaseToken): Promise<void> {
        if (!batch.failure && batch.records.length === 0) return;
        // Failing to get the sequence fails the poll like a DLQ write failure: the checkpoint does not move.
        const seq = await this.sequences.next(PVMBG_RECEIVE_SEQUENCE);
        if (batch.failure) {
            await this.unprocessed.record(
                {
                    source: HazardSource.Pvmbg,
                    context: PVMBG_RESPONSE_CONTEXT,
                    payload: batch.failure.payload,
                    contentType: batch.contentType,
                    correlationId,
                    ordering: { seq, index: null },
                    error: batch.failure.error,
                },
                lease
            );
        }
        for (const [index, record] of batch.records.entries()) {
            await this.ingestIsolated(record, batch.contentType, correlationId, lease, { seq, index });
        }
    }

    async ingestVolcanicReports(reports: VolcanicReport[], correlationId: string, lease: LeaseToken): Promise<void> {
        const records = reports.map((report) => ({ raw: Buffer.from(JSON.stringify(report)), value: report }));
        await this.ingestVolcanicBatch({ records, contentType: 'application/json' }, correlationId, lease);
    }

    async reprocessVolcanicRecord(
        raw: Buffer,
        correlationId: string,
        lease: LeaseToken,
        ordering: ReceiveOrder | null | undefined
    ): Promise<VolcanicIngestResult> {
        const value = decodeJson(raw, { maxDepth: env.DECODE_MAX_DEPTH });
        return this.ingestVolcanicRecord(value, correlationId, lease, ordering ?? LEGACY_RECEIVE_ORDER);
    }

    async reprocessVolcanicResponse(
        raw: Buffer,
        correlationId: string,
        lease: LeaseToken,
        ordering: ReceiveOrder | null | undefined
    ): Promise<void> {
        const parsed = decodeJson(raw, { maxDepth: env.DECODE_MAX_DEPTH });
        const seq = (ordering ?? LEGACY_RECEIVE_ORDER).seq;
        for (const [index, record] of toRawRecords(raw, parsed).entries()) {
            await this.ingestIsolated(record, 'application/json', correlationId, lease, { seq, index });
        }
    }

    private async ingestIsolated(
        record: RawRecord,
        contentType: string,
        correlationId: string,
        lease: LeaseToken,
        ordering: ReceiveOrder
    ): Promise<void> {
        try {
            await this.ingestVolcanicRecord(record.value, correlationId, lease, ordering);
        } catch (error) {
            if (error instanceof LeaseLostError) throw error;
            await this.unprocessed.record(
                {
                    source: HazardSource.Pvmbg,
                    context: PVMBG_RECORD_CONTEXT,
                    payload: { kind: 'inline', bytes: record.raw },
                    contentType,
                    correlationId,
                    sourceRefId: extractString(record.value, 'report_id'),
                    ordering,
                    error: classifyError(error),
                },
                lease
            );
        }
    }

    private async ingestVolcanicRecord(
        value: unknown,
        correlationId: string,
        lease: LeaseToken,
        ordering: ReceiveOrder
    ): Promise<VolcanicIngestResult> {
        const report = validateRecord(value, volcanicReportSchema, PVMBG_VOLCANIC_FIELDS);
        const { report_id, volcano_id, alert_level, reported_at, ...attributes } = report;
        const location = findVolcanoLocation(volcano_id);
        if (!location) {
            throw new ProcessingError(
                'validation_failed',
                `volcano_id '${volcano_id}' tidak ada di tabel referensi BNPB`
            );
        }
        const occurredAt = new Date(reported_at);
        const result = await this.hazardEventRepository.upsertAndEnqueue({
            source: HazardSource.Pvmbg,
            sourceRefId: report_id,
            hazardType: HazardType.Volcanic,
            severity: this.toCanonicalSeverity(alert_level),
            areaName: location.areaName,
            latitude: location.latitude,
            longitude: location.longitude,
            occurredAt,
            attributes,
            topic: env.KAFKA_TOPIC,
            correlationId,
            lease,
            version: pvmbgVersion(occurredAt, ordering),
        });
        if (result.superseded) {
            hazardWritesSupersededTotal.inc({ source: HazardSource.Pvmbg });
            logger.info(
                { hazardId: result.hazardEvent.hazardId, reportId: report_id, reportedAt: reported_at, correlationId },
                'Skipped PVMBG report: a newer report of the same report_id is already stored'
            );
        }
        this.logIngestion(result, correlationId);
        return { hazardId: result.hazardEvent.hazardId, superseded: result.superseded === true };
    }

    async ingestSeismicEvents(events: SeismicEvent[], correlationId: string, lease: LeaseToken): Promise<void> {
        for (const event of events) {
            const result = await this.hazardEventRepository.upsertAndEnqueue({
                source: HazardSource.Bmkg,
                sourceRefId: event.event_id,
                hazardType: HazardType.Seismic,
                severity: this.toSeismicSeverity(event.magnitude),
                areaName: event.region_name,
                latitude: event.epicenter_lat,
                longitude: event.epicenter_lon,
                occurredAt: new Date(event.occurred_at),
                attributes: {
                    magnitude: event.magnitude,
                    depth_km: event.depth_km,
                    potential_tsunami: event.potential_tsunami,
                },
                topic: env.KAFKA_TOPIC,
                correlationId,
                lease,
            });
            this.logIngestion(result, correlationId);
        }

        await this.resolvePendingTsunamiWarnings(correlationId, lease);
    }

    async ingestTsunamiWarnings(warnings: TsunamiWarning[], correlationId: string, lease: LeaseToken): Promise<void> {
        for (const warning of warnings) {
            const applied = await this.applyTsunamiWarning(warning, correlationId, lease);
            if (!applied) {
                await this.pendingTsunamiWarningRepository.save(warning, lease);
                logger.info(
                    { warningId: warning.warning_id, relatedEventId: warning.related_event_id, correlationId },
                    'Stored pending tsunami warning until its seismic event arrives'
                );
            }
        }
    }

    private async resolvePendingTsunamiWarnings(correlationId: string, lease: LeaseToken): Promise<void> {
        const pendingWarnings = await this.pendingTsunamiWarningRepository.findOldest(100);
        for (const pendingWarning of pendingWarnings) {
            if (await this.applyTsunamiWarning(pendingWarning.warning, correlationId, lease)) {
                await this.pendingTsunamiWarningRepository.remove(pendingWarning.warningId, lease);
            }
        }
    }

    private async applyTsunamiWarning(
        warning: TsunamiWarning,
        correlationId: string,
        lease: LeaseToken
    ): Promise<boolean> {
        const seismicEvent = await this.hazardEventRepository.findBySourceAndRefId(
            HazardSource.Bmkg,
            warning.related_event_id
        );
        if (!seismicEvent || seismicEvent.hazardType !== HazardType.Seismic) {
            return false;
        }

        const result = await this.hazardEventRepository.upsertAndEnqueue({
            source: seismicEvent.source,
            sourceRefId: seismicEvent.sourceRefId,
            hazardType: seismicEvent.hazardType,
            severity: this.toCanonicalSeverity(warning.threat_level),
            areaName: seismicEvent.areaName,
            latitude: seismicEvent.latitude,
            longitude: seismicEvent.longitude,
            occurredAt: seismicEvent.occurredAt,
            attributes: {
                ...seismicEvent.attributes,
                tsunami_warning: {
                    warning_id: warning.warning_id,
                    threat_level: warning.threat_level,
                    affected_zones: warning.affected_zones,
                    estimated_arrival: warning.estimated_arrival,
                },
            },
            topic: env.KAFKA_TOPIC,
            correlationId,
            lease,
        });
        this.logIngestion(result, correlationId);
        return true;
    }

    private toCanonicalSeverity(value: 'Normal' | 'Waspada' | 'Siaga' | 'Awas'): HazardSeverity {
        return HazardSeverity[value];
    }

    private toSeismicSeverity(magnitude: number): HazardSeverity {
        if (magnitude >= 6.5) {
            return HazardSeverity.Siaga;
        }
        if (magnitude >= 5.0) {
            return HazardSeverity.Waspada;
        }
        return HazardSeverity.Normal;
    }

    private logIngestion(result: HazardEventUpsertResult, correlationId: string): void {
        if (!result.changeType) {
            return;
        }

        logger.info(
            {
                hazardId: result.hazardEvent.hazardId,
                eventType: result.changeType,
                correlationId,
            },
            'Ingested canonical hazard event and queued its outbox event'
        );
    }
}

function extractString(value: unknown, key: string): string | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' && field.length <= 256 ? field : null;
}
