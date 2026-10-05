import { inject, injectable } from 'inversify';
import { SeismicEvent, TsunamiWarning, VolcanicReport } from '../clients/source-client.types';
import { getVolcanoLocation } from '../constants/volcano-locations';
import { TYPES } from '../constants/types';
import { HazardSeverity, HazardSource, HazardType } from '../db/schema/hazard-events';
import { logger } from '../libs/logger';
import { HazardEventUpsertResult, IHazardEventRepository } from '../repositories/hazard-event.repository';
import { IPendingTsunamiWarningRepository } from '../repositories/pending-tsunami-warning.repository';
import env from '../util/env';

export interface IHazardEventIngestionService {
    ingestSeismicEvents(events: SeismicEvent[], correlationId: string): Promise<void>;
    ingestVolcanicReports(reports: VolcanicReport[], correlationId: string): Promise<void>;
    ingestTsunamiWarnings(warnings: TsunamiWarning[], correlationId: string): Promise<void>;
}

@injectable()
export class HazardEventIngestionService implements IHazardEventIngestionService {
    constructor(
        @inject(TYPES.IHazardEventRepository)
        private readonly hazardEventRepository: IHazardEventRepository,
        @inject(TYPES.IPendingTsunamiWarningRepository)
        private readonly pendingTsunamiWarningRepository: IPendingTsunamiWarningRepository
    ) {}

    async ingestVolcanicReports(reports: VolcanicReport[], correlationId: string): Promise<void> {
        for (const report of reports) {
            const { report_id, volcano_id, alert_level, reported_at, ...attributes } = report;
            const location = getVolcanoLocation(volcano_id);
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
            });
            this.logIngestion(result, correlationId);
        }
    }

    async ingestSeismicEvents(events: SeismicEvent[], correlationId: string): Promise<void> {
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
            });
            this.logIngestion(result, correlationId);
        }

        await this.resolvePendingTsunamiWarnings(correlationId);
    }

    async ingestTsunamiWarnings(warnings: TsunamiWarning[], correlationId: string): Promise<void> {
        for (const warning of warnings) {
            const applied = await this.applyTsunamiWarning(warning, correlationId);
            if (!applied) {
                await this.pendingTsunamiWarningRepository.save(warning);
                logger.info(
                    { warningId: warning.warning_id, relatedEventId: warning.related_event_id, correlationId },
                    'Stored pending tsunami warning until its seismic event arrives'
                );
            }
        }
    }

    private async resolvePendingTsunamiWarnings(correlationId: string): Promise<void> {
        const pendingWarnings = await this.pendingTsunamiWarningRepository.findOldest(100);
        for (const pendingWarning of pendingWarnings) {
            if (await this.applyTsunamiWarning(pendingWarning.warning, correlationId)) {
                await this.pendingTsunamiWarningRepository.remove(pendingWarning.warningId);
            }
        }
    }

    private async applyTsunamiWarning(warning: TsunamiWarning, correlationId: string): Promise<boolean> {
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
