import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { ISensorPantaiClient } from '../clients/sensor-pantai.client';
import { SensorClientError, sensorObservationSchema } from '../clients/sensor-pantai.types';
import { TYPES } from '../constants/types';
import { LeaseLostError } from '../db/schema/background-leases';
import { HazardSeverity, HazardSource, HazardType } from '../db/schema/hazard-events';
import { logger } from '../libs/logger';
import { IBackgroundLeaseRepository } from '../repositories/background-lease.repository';
import { IHazardEventRepository, UpsertHazardEventInput } from '../repositories/hazard-event.repository';
import { ISensorPantaiRepository } from '../repositories/sensor-pantai.repository';
import env from '../util/env';
import { IBackgroundLeadershipService } from './background-leadership.service';

export interface ISensorPantaiService {
    start(): void;
    stop(): void;
}

@injectable()
export class SensorPantaiService implements ISensorPantaiService {
    private stopped = true;
    private timer: NodeJS.Timeout | undefined;

    constructor(
        @inject(TYPES.ISensorPantaiClient) private readonly client: ISensorPantaiClient,
        @inject(TYPES.ISensorPantaiRepository) private readonly repository: ISensorPantaiRepository,
        @inject(TYPES.IHazardEventRepository) private readonly hazards: IHazardEventRepository,
        @inject(TYPES.IBackgroundLeadershipService) private readonly leadership: IBackgroundLeadershipService,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository
    ) {}

    start(): void {
        if (!env.SENSOR_PANTAI_ENABLED || !this.stopped) return;
        this.stopped = false;
        this.schedule(0);
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule(delay: number): void {
        this.timer = setTimeout(() => {
            if (this.stopped) return;
            void this.pollOnce()
                .catch((error) => logger.error({ error }, 'Sensor Pantai poll failed unexpectedly'))
                .finally(() => {
                    if (!this.stopped) this.schedule(env.SENSOR_PANTAI_POLL_INTERVAL_MS);
                });
        }, delay);
    }

    private async pollOnce(): Promise<void> {
        const lease = this.leadership.current();
        if (!lease) return;
        const correlationId = randomUUID();
        try {
            let state = await this.repository.getState();
            let at = await this.leases.requireActive(lease);
            if (state.retryAt && state.retryAt > at) return;
            const options = { correlationId, instanceId: lease.ownerId, fencingToken: lease.epoch };
            let refreshedStations = false;
            if (
                !state.stations.length ||
                !state.stationsUpdatedAt ||
                at.getTime() - state.stationsUpdatedAt.getTime() >= 60000
            ) {
                state.stations = await this.client.getStations(options);
                state.stationsUpdatedAt = at;
                refreshedStations = true;
            }
            const stations = new Map(state.stations.map((station) => [station.station_id, station]));
            for (let pageNumber = 0; pageNumber < env.SENSOR_PANTAI_MAX_PAGES_PER_POLL && !this.stopped; pageNumber++) {
                at = await this.leases.requireActive(lease);
                const page = await this.client.getObservations(state.cursor, options);
                const priorCursor = state.cursor;
                const critical = (value: unknown) =>
                    value !== null && typeof value === 'object' && 'critical' in value && value.critical === true;
                const items = [...page.items].sort((left, right) => Number(critical(right)) - Number(critical(left)));
                if (
                    !refreshedStations &&
                    items.some((raw) => {
                        const parsed = sensorObservationSchema.safeParse(raw);
                        return parsed.success && !stations.has(parsed.data.station_id);
                    })
                ) {
                    state.stations = await this.client.getStations(options);
                    state.stationsUpdatedAt = at;
                    stations.clear();
                    for (const station of state.stations) stations.set(station.station_id, station);
                    refreshedStations = true;
                }
                const criticalInputs: UpsertHazardEventInput[] = [];
                const normalInputs: UpsertHazardEventInput[] = [];
                const rejected: { payload: unknown; reason: string }[] = [];
                for (const raw of items) {
                    if (Buffer.byteLength(JSON.stringify(raw)) > env.SENSOR_PANTAI_MAX_RECORD_BYTES) {
                        rejected.push({ payload: raw, reason: 'Observation exceeds record size limit' });
                        continue;
                    }
                    const parsed = sensorObservationSchema.safeParse(raw);
                    if (!parsed.success) {
                        rejected.push({
                            payload: raw,
                            reason: parsed.error.issues
                                .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                                .join('; '),
                        });
                        continue;
                    }
                    const observation = parsed.data;
                    const station = stations.get(observation.station_id);
                    const occurredAt = new Date(observation.observed_at);
                    if (
                        !station ||
                        occurredAt.getTime() > page.generatedAt.getTime() + env.SENSOR_PANTAI_MAX_FUTURE_MS
                    ) {
                        rejected.push({
                            payload: raw,
                            reason: station ? 'Observation is ahead of source generated_at' : 'Unknown station_id',
                        });
                        continue;
                    }
                    const { observation_id, observed_at, ...attributes } = observation;
                    (observation.critical ? criticalInputs : normalInputs).push({
                        source: HazardSource.SensorPantai,
                        sourceRefId: observation_id,
                        hazardType: HazardType.Coastal,
                        severity: observation.critical ? HazardSeverity.Awas : HazardSeverity.Normal,
                        areaName: station.name,
                        latitude: station.latitude,
                        longitude: station.longitude,
                        occurredAt,
                        attributes: { ...attributes, province: station.province },
                        topic: env.KAFKA_TOPIC,
                        correlationId,
                        lease,
                    });
                    if (!state.latestObservedAt || occurredAt > state.latestObservedAt)
                        state.latestObservedAt = occurredAt;
                }
                await this.ingest(criticalInputs, correlationId);
                await this.ingest(normalInputs, correlationId);
                for (let offset = 0; offset < rejected.length; offset += 50) {
                    await this.repository.rejectBatch(rejected.slice(offset, offset + 50), correlationId, lease);
                }
                const regressed = state.generatedAt && page.generatedAt < state.generatedAt;
                if (!state.generatedAt || page.generatedAt > state.generatedAt) {
                    state.sourceProgressAt = at;
                    state.generatedAt = page.generatedAt;
                }
                // A null cursor at EOF must retain our last position, not restart the feed.
                state.cursor = page.nextCursor ?? state.cursor;
                const atTail = page.items.length === 0 || page.nextCursor === null || page.nextCursor === priorCursor;
                const behind =
                    state.latestObservedAt &&
                    page.generatedAt.getTime() - state.latestObservedAt.getTime() > env.SENSOR_PANTAI_MAX_SOURCE_LAG_MS;
                const frozen =
                    state.sourceProgressAt &&
                    at.getTime() - state.sourceProgressAt.getTime() > env.SENSOR_PANTAI_STALE_AFTER_MS;
                state = await this.repository.checkpoint(
                    state,
                    Boolean(regressed || frozen || (atTail && behind)),
                    lease
                );
                logger.info(
                    {
                        source: 'SENSOR_PANTAI',
                        records: page.items.length,
                        status: state.status,
                        sourceLagMs: state.latestObservedAt
                            ? page.generatedAt.getTime() - state.latestObservedAt.getTime()
                            : null,
                        retryAt: state.retryAt,
                        correlationId,
                    },
                    'Checkpointed Sensor Pantai page'
                );
                if (atTail || state.retryAt) break;
            }
        } catch (error) {
            if (error instanceof LeaseLostError) {
                this.leadership.invalidate(lease);
                return;
            }
            try {
                if (error instanceof SensorClientError && error.rawBody !== undefined) {
                    await this.repository.reject(
                        { encoding: 'base64', body: error.rawBody, truncated: error.truncated },
                        error.message,
                        correlationId,
                        lease
                    );
                }
                await this.repository.recordFailure(
                    error instanceof Error ? error.message : String(error),
                    error instanceof SensorClientError ? error.retryAfterMs : 0,
                    lease
                );
            } catch (stateError) {
                if (stateError instanceof LeaseLostError) this.leadership.invalidate(lease);
                logger.error({ error: stateError, correlationId }, 'Could not record Sensor Pantai failure');
            }
            logger.warn(
                {
                    reason: error instanceof Error ? error.message : String(error),
                    statusCode: error instanceof SensorClientError ? error.status : undefined,
                    correlationId,
                },
                'Sensor Pantai poll failed; checkpoint retained'
            );
        }
    }

    private async ingest(inputs: UpsertHazardEventInput[], correlationId: string): Promise<void> {
        for (let offset = 0; offset < inputs.length;) {
            const batch: UpsertHazardEventInput[] = [];
            const ids = new Set<string>();
            while (offset < inputs.length && batch.length < 50 && !ids.has(inputs[offset].sourceRefId)) {
                ids.add(inputs[offset].sourceRefId);
                batch.push(inputs[offset++]);
            }
            const results = await this.hazards.upsertBatchAndEnqueue(batch);
            for (const result of results) {
                if (result.changeType)
                    logger.info(
                        {
                            sourceRefId: result.hazardEvent.sourceRefId,
                            hazardId: result.hazardEvent.hazardId,
                            critical: result.hazardEvent.attributes.critical,
                            correlationId,
                        },
                        'Ingested coastal observation and queued outbox event'
                    );
            }
        }
    }
}
