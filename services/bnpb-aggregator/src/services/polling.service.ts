import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { markActiveSpanError, traced } from '../telemetry/context';
import { IBmkgClient } from '../clients/bmkg.client';
import { IPvmbgClient } from '../clients/pvmbg.client';
import { PollRequestOptions } from '../clients/source-client.types';
import { TYPES } from '../constants/types';
import { SourceStream } from '../db/schema/source-sync-states';
import { logger } from '../libs/logger';
import env from '../util/env';
import { IHazardEventIngestionService } from './hazard-event-ingestion.service';
import { ISourceSyncStateService } from './source-sync-state.service';
import { IBackgroundLeadershipService } from './background-leadership.service';
import { IBackgroundLeaseRepository } from '../repositories/background-lease.repository';
import { LeaseLostError, LeaseToken } from '../db/schema/background-leases';
import { IPvmbgBodyFailureService, SkippedWindow } from './pvmbg-body-failure.service';
import { pollCheckpoint } from '../repositories/source-sync-state.repository';

// a skipped window (D-44) moves the cursor without counting as a successful poll
type PollWork = (options: PollRequestOptions, lease: LeaseToken) => Promise<SkippedWindow | void>;

export interface IPollingService {
    start(): void;
    stop(): void;
}

@injectable()
export class PollingService implements IPollingService {
    private readonly timers = new Map<SourceStream, NodeJS.Timeout>();
    private stopped = true;

    constructor(
        @inject(TYPES.IBmkgClient) private readonly bmkgClient: IBmkgClient,
        @inject(TYPES.IPvmbgClient) private readonly pvmbgClient: IPvmbgClient,
        @inject(TYPES.IHazardEventIngestionService) private readonly ingestionService: IHazardEventIngestionService,
        @inject(TYPES.ISourceSyncStateService) private readonly sourceSyncStateService: ISourceSyncStateService,
        @inject(TYPES.IBackgroundLeadershipService) private readonly leadership: IBackgroundLeadershipService,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository,
        @inject(TYPES.IPvmbgBodyFailureService) private readonly pvmbgBodyFailures: IPvmbgBodyFailureService
    ) {}

    start(): void {
        if (!this.stopped) {
            return;
        }

        this.stopped = false;
        this.schedule(SourceStream.BmkgSeismic, (options, lease) => this.pollBmkgSeismic(options, lease), 0);
        this.schedule(
            SourceStream.BmkgTsunamiWarning,
            (options, lease) => this.pollBmkgTsunamiWarnings(options, lease),
            0
        );
        this.schedule(SourceStream.PvmbgVolcanic, (options, lease) => this.pollPvmbgVolcanic(options, lease), 0);
        logger.info({ intervalMs: env.POLL_INTERVAL_MS }, 'Source pollers started');
    }

    stop(): void {
        this.stopped = true;
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        logger.info('Source pollers stopped');
    }

    private schedule(sourceStream: SourceStream, work: PollWork, delayMs: number): void {
        const timer = setTimeout(() => {
            if (this.timers.get(sourceStream) !== timer) {
                return;
            }
            void this.runAndReschedule(sourceStream, work);
        }, delayMs);
        this.timers.set(sourceStream, timer);
    }

    private async runAndReschedule(sourceStream: SourceStream, work: PollWork): Promise<void> {
        this.timers.delete(sourceStream);
        if (this.stopped) {
            return;
        }

        try {
            await this.runOnce(sourceStream, work);
        } finally {
            if (!this.stopped) {
                this.schedule(sourceStream, work, env.POLL_INTERVAL_MS);
            }
        }
    }

    private async runOnce(sourceStream: SourceStream, work: PollWork): Promise<void> {
        const lease = this.leadership.current();
        if (!lease) return;
        const correlationId = randomUUID();
        return traced('source.poll', { 'source.stream': sourceStream, 'correlation.id': correlationId }, async () => {
            try {
                const checkpoint = pollCheckpoint(await this.sourceSyncStateService.getState(sourceStream));
                const since = checkpoint ? new Date(checkpoint.getTime() - env.POLL_OVERLAP_MS) : undefined;

                const startedAt = await this.leases.requireActive(lease);
                // startedAt is additive (D-34 skipped-window record); PERLU DIKONFIRMASI KE A/B
                const skipped = await work(
                    { since, correlationId, instanceId: lease.ownerId, fencingToken: lease.epoch, startedAt },
                    lease
                );
                if (this.stopped) {
                    logger.info({ sourceStream, correlationId }, 'Source poll cancelled during shutdown');
                    return;
                }
                if (skipped) {
                    await this.sourceSyncStateService.recordSkippedWindow(sourceStream, startedAt, skipped.error, lease);
                    logger.warn(
                        { sourceStream, since, correlationId, messageId: skipped.messageId },
                        'Source poll skipped a window; source stays stale until a valid body arrives'
                    );
                    return;
                }
                await this.sourceSyncStateService.recordSuccessfulPoll(sourceStream, startedAt, lease);
                logger.info(
                    { sourceStream, since, correlationId, instanceId: lease.ownerId, epoch: lease.epoch },
                    'Source poll completed successfully'
                );
            } catch (error) {
                if (error instanceof LeaseLostError) {
                    this.leadership.invalidate(lease);
                    logger.info(
                        { sourceStream, correlationId, instanceId: lease.ownerId, epoch: lease.epoch },
                        'Discarded work after losing background lease'
                    );
                    return;
                }
                if (this.stopped) {
                    logger.info({ sourceStream, correlationId }, 'Source poll ended during shutdown');
                    return;
                }
                logger.error({ error, sourceStream, correlationId }, 'Source poll failed');
                markActiveSpanError(error);
                try {
                    const at = await this.leases.requireActive(lease);
                    await this.sourceSyncStateService.recordFailedPoll(sourceStream, error, at, lease);
                } catch (stateError) {
                    if (stateError instanceof LeaseLostError) this.leadership.invalidate(lease);
                    logger.error(
                        { error: stateError, sourceStream, correlationId },
                        'Failed to record source poll failure'
                    );
                }
            }
        });
    }

    private async pollBmkgSeismic(options: PollRequestOptions, lease: LeaseToken): Promise<void> {
        const events = await this.bmkgClient.getSeismicEvents(options);
        await this.ingestionService.ingestSeismicEvents(events, options.correlationId, lease);
    }

    private async pollBmkgTsunamiWarnings(options: PollRequestOptions, lease: LeaseToken): Promise<void> {
        const warnings = await this.bmkgClient.getTsunamiWarnings(options);
        await this.ingestionService.ingestTsunamiWarnings(warnings, options.correlationId, lease);
    }

    private async pollPvmbgVolcanic(options: PollRequestOptions, lease: LeaseToken): Promise<SkippedWindow | void> {
        const batch = await this.pvmbgClient.getVolcanicReports(options);
        const result = await this.ingestionService.ingestVolcanicBatch(batch, options.correlationId, lease);
        // D-34/D-44: a broken body holds the checkpoint (throws) until K consecutive body failures, then skips the window
        if (result?.bodyFailure) {
            return this.pvmbgBodyFailures.onBodyFailure(
                result.bodyFailure,
                { since: options.since, until: options.startedAt ?? new Date(), correlationId: options.correlationId },
                lease
            );
        }
    }
}
