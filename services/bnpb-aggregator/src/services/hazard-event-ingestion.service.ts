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

export interface IHazardEventIngestionService {
    ingestSeismicEvents(events: SeismicEvent[], correlationId: string, lease: LeaseToken): Promise<void>;
    ingestVolcanicBatch(batch: VolcanicReportBatch, correlationId: string, lease: LeaseToken): Promise<void>;
    ingestVolcanicReports(reports: VolcanicReport[], correlationId: string, lease: LeaseToken): Promise<void>;
    ingestTsunamiWarnings(warnings: TsunamiWarning[], correlationId: string, lease: LeaseToken): Promise<void>;
    /**
     * DLQ handler: one stored PVMBG record (raw bytes) → HazardEvent. `receivedAt` is when the record first
     * arrived (the DLQ entry), so the replay keeps its place in the receive order. Throws ProcessingError on failure.
     */
    reprocessVolcanicRecord(
        raw: Buffer,
        correlationId: string,
        lease: LeaseToken,
        receivedAt: Date
    ): Promise<VolcanicIngestResult>;
    /** DLQ handler: one stored PVMBG response body → per-record ingestion (failures get their own entries). */
    reprocessVolcanicResponse(raw: Buffer, correlationId: string, lease: LeaseToken, receivedAt: Date): Promise<void>;
}

export interface VolcanicIngestResult {
    hazardId: string;
    /** A newer report of the same report_id is already stored; nothing changed. */
    superseded: boolean;
}

/**
 * Ordering version of a PVMBG report per report_id (review #3, rule 9b): reported_at, tie-broken by the time
 * BNPB received it. Both parts are fixed-width ISO-8601 UTC, so plain string order is chronological order.
 * The same report received again later has the same reported_at and a later receive time.
 */
export function pvmbgVersion(reportedAt: Date, receivedAt: Date): string {
    return `${reportedAt.toISOString()}|${receivedAt.toISOString()}`;
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
        private readonly unprocessed: IUnprocessedRecorder
    ) {}

    /**
     * Record isolation: a failing record is stored as an unprocessed message and the rest of the batch
     * continues. Only lease loss and a failure to store the message itself abort the poll.
     */
    async ingestVolcanicBatch(batch: VolcanicReportBatch, correlationId: string, lease: LeaseToken): Promise<void> {
        const receivedAt = new Date();
        if (batch.failure) {
            await this.unprocessed.record(
                {
                    source: HazardSource.Pvmbg,
                    context: PVMBG_RESPONSE_CONTEXT,
                    payload: batch.failure.payload,
                    contentType: batch.contentType,
                    correlationId,
                    error: batch.failure.error,
                },
                lease
            );
        }
        for (const record of batch.records) {
            await this.ingestIsolated(record, batch.contentType, correlationId, lease, receivedAt);
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
        receivedAt: Date
    ): Promise<VolcanicIngestResult> {
        const value = decodeJson(raw, { maxDepth: env.DECODE_MAX_DEPTH });
        return this.ingestVolcanicRecord(value, correlationId, lease, receivedAt);
    }

    async reprocessVolcanicResponse(
        raw: Buffer,
        correlationId: string,
        lease: LeaseToken,
        receivedAt: Date
    ): Promise<void> {
        const parsed = decodeJson(raw, { maxDepth: env.DECODE_MAX_DEPTH });
        for (const record of toRawRecords(raw, parsed)) {
            await this.ingestIsolated(record, 'application/json', correlationId, lease, receivedAt);
        }
    }

    private async ingestIsolated(
        record: RawRecord,
        contentType: string,
        correlationId: string,
        lease: LeaseToken,
        receivedAt: Date
    ): Promise<void> {
        try {
            await this.ingestVolcanicRecord(record.value, correlationId, lease, receivedAt);
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
        receivedAt: Date
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
            version: pvmbgVersion(occurredAt, receivedAt),
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
