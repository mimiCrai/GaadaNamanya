import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { IBmkgClient } from '../clients/bmkg.client';
import { IPvmbgClient } from '../clients/pvmbg.client';
import { PollRequestOptions } from '../clients/source-client.types';
import { TYPES } from '../constants/types';
import { SourceStream } from '../db/schema/source-sync-states';
import { logger } from '../libs/logger';
import env from '../util/env';
import { IHazardEventIngestionService } from './hazard-event-ingestion.service';
import { ISourceSyncStateService } from './source-sync-state.service';

type PollWork = (options: PollRequestOptions) => Promise<void>;

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
        @inject(TYPES.ISourceSyncStateService) private readonly sourceSyncStateService: ISourceSyncStateService
    ) {}

    start(): void {
        if (!this.stopped) {
            return;
        }

        this.stopped = false;
        this.schedule(SourceStream.BmkgSeismic, (options) => this.pollBmkgSeismic(options), 0);
        this.schedule(SourceStream.BmkgTsunamiWarning, (options) => this.pollBmkgTsunamiWarnings(options), 0);
        this.schedule(SourceStream.PvmbgVolcanic, (options) => this.pollPvmbgVolcanic(options), 0);
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
        const correlationId = randomUUID();
        try {
            const state = await this.sourceSyncStateService.getState(sourceStream);
            const since = state?.lastSuccessfulPollAt
                ? new Date(state.lastSuccessfulPollAt.getTime() - env.POLL_OVERLAP_MS)
                : undefined;

            await work({ since, correlationId });
            if (this.stopped) {
                logger.info({ sourceStream, correlationId }, 'Source poll cancelled during shutdown');
                return;
            }
            await this.sourceSyncStateService.recordSuccessfulPoll(sourceStream);
            logger.info({ sourceStream, since, correlationId }, 'Source poll completed successfully');
        } catch (error) {
            if (this.stopped) {
                logger.info({ sourceStream, correlationId }, 'Source poll ended during shutdown');
                return;
            }
            logger.error({ error, sourceStream, correlationId }, 'Source poll failed');
            try {
                await this.sourceSyncStateService.recordFailedPoll(sourceStream, error);
            } catch (stateError) {
                logger.error({ error: stateError, sourceStream, correlationId }, 'Failed to record source poll failure');
            }
        }
    }

    private async pollBmkgSeismic(options: PollRequestOptions): Promise<void> {
        const events = await this.bmkgClient.getSeismicEvents(options);
        await this.ingestionService.ingestSeismicEvents(events, options.correlationId);
    }

    private async pollBmkgTsunamiWarnings(options: PollRequestOptions): Promise<void> {
        const warnings = await this.bmkgClient.getTsunamiWarnings(options);
        await this.ingestionService.ingestTsunamiWarnings(warnings, options.correlationId);
    }

    private async pollPvmbgVolcanic(options: PollRequestOptions): Promise<void> {
        const reports = await this.pvmbgClient.getVolcanicReports(options);
        await this.ingestionService.ingestVolcanicReports(reports, options.correlationId);
    }
}
