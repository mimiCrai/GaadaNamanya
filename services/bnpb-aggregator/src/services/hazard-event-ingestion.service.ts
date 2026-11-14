import { inject, injectable } from 'inversify';
import { PVMBG_ENDPOINT, PVMBG_RECORD_KIND, PVMBG_RESPONSE_KIND, VolcanicReportBatch } from '../clients/pvmbg.client';
import { PVMBG_VOLCANIC_FIELDS, volcanicReportSchema } from '../clients/pvmbg.schema';
import { SeismicEvent, TsunamiWarning, VolcanicReport } from '../clients/source-client.types';
import { findVolcanoLocation } from '../constants/volcano-locations';
import { TYPES } from '../constants/types';
import { HazardSeverity, HazardSource, HazardType } from '../db/schema/hazard-events';
import { logger } from '../libs/logger';
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
    /** DLQ handler: one stored PVMBG record (raw bytes) → HazardEvent. Throws ProcessingError on failure. */
    reprocessVolcanicRecord(raw: Buffer, correlationId: string, lease: LeaseToken): Promise<string>;
    /** DLQ handler: one stored PVMBG response body → per-record ingestion (failures get their own entries). */
    reprocessVolcanicResponse(raw: Buffer, correlationId: string, lease: LeaseToken): Promise<void>;
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
            await this.ingestIsolated(record, batch.contentType, correlationId, lease);
        }
    }

    async ingestVolcanicReports(reports: VolcanicReport[], correlationId: string, lease: LeaseToken): Promise<void> {
        const records = reports.map((report) => ({ raw: Buffer.from(JSON.stringify(report)), value: report }));
        await this.ingestVolcanicBatch({ records, contentType: 'application/json' }, correlationId, lease);
    }

    async reprocessVolcanicRecord(raw: Buffer, correlationId: string, lease: LeaseToken): Promise<string> {
        const value = decodeJson(raw, { maxDepth: env.DECODE_MAX_DEPTH });
        return this.ingestVolcanicRecord(value, correlationId, lease);
    }

    async reprocessVolcanicResponse(raw: Buffer, correlationId: string, lease: LeaseToken): Promise<void> {
        const parsed = decodeJson(raw, { maxDepth: env.DECODE_MAX_DEPTH });
        for (const record of toRawRecords(raw, parsed)) {
            await this.ingestIsolated(record, 'application/json', correlationId, lease);
        }
    }

    private async ingestIsolated(
        record: RawRecord,
        contentType: string,
        correlationId: string,
        lease: LeaseToken
    ): Promise<void> {
        try {
            await this.ingestVolcanicRecord(record.value, correlationId, lease);
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

    private async ingestVolcanicRecord(value: unknown, correlationId: string, lease: LeaseToken): Promise<string> {
        const report = validateRecord(value, volcanicReportSchema, PVMBG_VOLCANIC_FIELDS);
        const { report_id, volcano_id, alert_level, reported_at, ...attributes } = report;
        const location = findVolcanoLocation(volcano_id);
        if (!location) {
            throw new ProcessingError(
                'validation_failed',
                `volcano_id '${volcano_id}' tidak ada di tabel referensi BNPB`
            );
        }
        const result = await this.hazardEventRepository.upsertAndEnqueue({
            source: HazardSource.Pvmbg,
            sourceRefId: report_id,
            hazardType: HazardType.Volcanic,
            severity: this.toCanonicalSeverity(alert_level),
            areaName: location.areaName,
            latitude: location.latitude,
            longitude: location.longitude,
            occurredAt: new Date(reported_at),
            attributes,
            topic: env.KAFKA_TOPIC,
            correlationId,
            lease,
        });
        this.logIngestion(result, correlationId);
        return result.hazardEvent.hazardId;
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
