import { inject, injectable } from 'inversify';
import { randomUUID } from 'node:crypto';
import { ISatelliteFeedClient, SATELLITE_STREAM_ENDPOINT, SatelliteHttpError } from '../clients/satellite.client';
import { TYPES } from '../constants/types';
import { LeaseLostError, LeaseToken } from '../db/schema/background-leases';
import { HazardSource } from '../db/schema/hazard-events';
import { computeBackoffMs } from '../libs/backoff';
import { logger } from '../libs/logger';
import {
    satelliteDuplicatesTotal,
    satelliteEventsTotal,
    satelliteGapsTotal,
    satelliteLagInputs,
    satelliteLastHeartbeatVirtualNow,
    satelliteLastOffsetDurable,
    satelliteLastOffsetReceived,
    satelliteLatestOffset,
    satelliteReconnectsTotal,
    satelliteSessionPollErrorsTotal,
    satelliteStreamConnected,
} from '../libs/metrics';
import { OffsetTracker } from '../libs/offset-tracker';
import { ProcessingError } from '../libs/processing-error';
import { payloadTooLarge } from '../libs/safe-decode';
import { decodeSatelliteEvent, parseOffsetId, SseEventItem } from '../libs/satellite-envelope';
import { SseItem, SseParser } from '../libs/sse-parser';
import type { RecordUnprocessedInput } from '../repositories/unprocessed-message.repository';
import env from '../util/env';
import { IBackgroundLeadershipService } from './background-leadership.service';
import { ISatelliteLogWriter, SatelliteRawRecord } from './satellite-log-writer.service';
import { IUnprocessedRecorder } from './unprocessed-recorder.service';

export const SATELLITE_EVENT_KIND = 'stream.event';

export type ReconnectReason =
    | 'eof'
    | 'network'
    | 'idle_timeout'
    | 'gap'
    | 'http_400'
    | 'http_401'
    | 'http_429'
    | 'http_503'
    | 'http_5xx'
    | 'http_other'
    | 'leadership_lost'
    | 'writer_error'
    | 'manual'
    | 'shutdown';

export interface SatelliteIngestConfig {
    enabled: boolean;
    batchMax: number;
    batchLingerMs: number;
    maxEventBytes: number;
    maxDepth: number;
    idleTimeoutMs: number;
    sessionPollMs: number;
    backoffBaseMs: number;
    backoffCapMs: number;
    backoff429BaseMs: number;
    backoff429CapMs: number;
    authBackoffMs: number;
    quickReconnectMs: number;
    leadershipWaitMs: number;
}

export function satelliteConfigFromEnv(): SatelliteIngestConfig {
    return {
        enabled: env.SATELLITE_INGEST_ENABLED,
        batchMax: env.SATELLITE_BATCH_MAX,
        batchLingerMs: env.SATELLITE_BATCH_LINGER_MS,
        maxEventBytes: env.SATELLITE_MAX_EVENT_BYTES,
        maxDepth: env.DECODE_MAX_DEPTH,
        idleTimeoutMs: env.SATELLITE_IDLE_TIMEOUT_MS,
        sessionPollMs: env.SATELLITE_SESSION_POLL_MS,
        backoffBaseMs: env.SATELLITE_BACKOFF_BASE_MS,
        backoffCapMs: env.SATELLITE_BACKOFF_CAP_MS,
        backoff429BaseMs: env.SATELLITE_429_BACKOFF_BASE_MS,
        backoff429CapMs: env.SATELLITE_429_BACKOFF_CAP_MS,
        authBackoffMs: env.SATELLITE_AUTH_BACKOFF_MS,
        quickReconnectMs: 250,
        leadershipWaitMs: 1_000,
    };
}

export function reconnectDelayMs(
    reason: ReconnectReason,
    attempt: number,
    config: SatelliteIngestConfig,
    random: () => number = Math.random,
    retryHintMs: number | null = null
): number {
    switch (reason) {
        case 'leadership_lost':
        case 'shutdown':
            return 0;
        case 'http_400':
        case 'http_401':
        case 'http_other':
            return config.authBackoffMs; // configuration problem: retrying fast only floods the logs
        case 'http_429':
            return computeBackoffMs(attempt, config.backoff429BaseMs, config.backoff429CapMs, random);
        case 'http_503':
        case 'http_5xx':
        case 'network':
        case 'writer_error':
            return computeBackoffMs(attempt, config.backoffBaseMs, config.backoffCapMs, random);
        case 'eof':
        case 'gap':
        case 'idle_timeout':
        case 'manual': {
            const base =
                attempt <= 1
                    ? config.quickReconnectMs
                    : computeBackoffMs(attempt - 1, config.backoffBaseMs, config.backoffCapMs, random);
            return Math.max(base, retryHintMs ?? 0);
        }
    }
}

export function classifyStreamError(error: unknown): ReconnectReason {
    if (error instanceof LeaseLostError) return 'leadership_lost';
    if (error instanceof SatelliteWriteError) return 'writer_error';
    if (error instanceof GapDetectedError) return 'gap';
    if (error instanceof SatelliteHttpError) {
        if (error.status === 400) return 'http_400';
        if (error.status === 401 || error.status === 403) return 'http_401';
        if (error.status === 429) return 'http_429';
        if (error.status === 503) return 'http_503';
        if (error.status >= 500) return 'http_5xx';
        return 'http_other';
    }
    return 'network';
}

export class SatelliteWriteError extends Error {
    constructor(cause: unknown) {
        super(`satellite durable write failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = 'SatelliteWriteError';
    }
}

export class GapDetectedError extends Error {
    constructor(
        readonly expected: number,
        readonly received: number
    ) {
        super(`offset gap: expected ${expected}, received ${received}`);
        this.name = 'GapDetectedError';
    }
}

export interface SatelliteIngestStatus {
    enabled: boolean;
    instance_id: string;
    leader: boolean;
    epoch: number | null;
    connected: boolean;
    current_from: number | null;
    last_offset_received: number | null;
    last_offset_durable: number | null;
    latest_offset: number | null;
    lag_offsets: number | null;
    last_heartbeat_virtual_now: string | null;
    session_speed: number | null;
    reconnects: Record<string, number>;
    events: Record<string, number>;
    duplicates: number;
    gaps: number;
    last_error: string | null;
}

export interface ISatelliteIngestService {
    start(): void;
    stop(): Promise<void>;
    status(): SatelliteIngestStatus;
    disconnect(): boolean;
}

interface PendingRecord {
    record: SatelliteRawRecord | null;
    dlq: RecordUnprocessedInput | null;
}

type Received =
    | { ok: true; kind: SatelliteRawRecord['kind']; dataText: string; virtualNow: string | null; receivedAt: string }
    | { ok: false; error: ProcessingError; payload: Buffer; receivedAt: string };

interface Session {
    lease: LeaseToken;
    controller: AbortController;
    correlationId: string;
    reason: ReconnectReason | null;
    discard: boolean;
    parser: SseParser;
    tracker: OffsetTracker<Received> | null;
    pending: PendingRecord[];
    flushing: Promise<void>;
    lingerTimer: NodeJS.Timeout | undefined;
    idleTimer: NodeJS.Timeout | undefined;
    retryHintMs: number | null;
    progressed: boolean;
    connected: boolean;
}

@injectable()
export class SatelliteIngestService implements ISatelliteIngestService {
    private config = satelliteConfigFromEnv();
    private random: () => number = Math.random;
    private stopped = true;
    private loopDone: Promise<void> | undefined;
    private active: Session | null = null;
    private wakeUp: (() => void) | null = null;
    private unsubscribe: (() => void) | undefined;
    private pollTimer: NodeJS.Timeout | undefined;
    private warnedIdleTimeout = false;

    private readonly stats = {
        currentFrom: null as number | null,
        lastReceived: null as number | null,
        lastDurable: null as number | null,
        latestOffset: null as number | null,
        lastHeartbeat: null as string | null,
        speed: null as number | null,
        reconnects: {} as Record<string, number>,
        events: {} as Record<string, number>,
        duplicates: 0,
        gaps: 0,
        lastError: null as string | null,
    };

    constructor(
        @inject(TYPES.ISatelliteFeedClient) private readonly client: ISatelliteFeedClient,
        @inject(TYPES.ISatelliteLogWriter) private readonly writer: ISatelliteLogWriter,
        @inject(TYPES.IBackgroundLeadershipService) private readonly leadership: IBackgroundLeadershipService,
        @inject(TYPES.IUnprocessedRecorder) private readonly recorder: IUnprocessedRecorder
    ) {}

    configure(config: Partial<SatelliteIngestConfig>, random?: () => number): void {
        this.config = { ...this.config, ...config };
        if (random) this.random = random;
    }

    start(): void {
        if (!this.stopped) return;
        if (!this.config.enabled) {
            logger.info('Satellite ingest disabled (SATELLITE_INGEST_ENABLED=false)');
            return;
        }
        this.stopped = false;
        this.unsubscribe = this.leadership.onChange((token) => this.onLeadershipChange(token));
        this.loopDone = this.loop();
        this.schedulePoll(0);
        logger.info({ instanceId: this.leadership.instanceId }, 'Satellite ingest started');
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.unsubscribe?.();
        if (this.pollTimer) clearTimeout(this.pollTimer);
        if (this.active) this.abortSession(this.active, 'shutdown');
        this.wake();
        await this.loopDone;
        await this.writer.close();
        satelliteStreamConnected.set(0);
        logger.info('Satellite ingest stopped');
    }

    disconnect(): boolean {
        if (!this.active || this.active.controller.signal.aborted) return false;
        this.abortSession(this.active, 'manual');
        return true;
    }

    status(): SatelliteIngestStatus {
        const lease = this.leadership.current();
        const { latestOffset, lastDurable } = this.stats;
        return {
            enabled: this.config.enabled,
            instance_id: this.leadership.instanceId,
            leader: Boolean(lease),
            epoch: lease?.epoch ?? null,
            connected: Boolean(this.active?.connected && !this.active.controller.signal.aborted),
            current_from: this.stats.currentFrom,
            last_offset_received: this.stats.lastReceived,
            last_offset_durable: lastDurable,
            latest_offset: latestOffset,
            lag_offsets: latestOffset !== null && lastDurable !== null ? Math.max(0, latestOffset - lastDurable) : null,
            last_heartbeat_virtual_now: this.stats.lastHeartbeat,
            session_speed: this.stats.speed,
            reconnects: { ...this.stats.reconnects },
            events: { ...this.stats.events },
            duplicates: this.stats.duplicates,
            gaps: this.stats.gaps,
            last_error: this.stats.lastError,
        };
    }

    private onLeadershipChange(token: LeaseToken | null): void {
        const session = this.active;
        if (session && (!token || token.epoch !== session.lease.epoch || token.ownerId !== session.lease.ownerId)) {
            this.abortSession(session, 'leadership_lost');
        }
        if (!token) this.resetLeaderGauges();
        this.wake();
    }

    private async loop(): Promise<void> {
        let attempt = 0;
        while (!this.stopped) {
            const lease = this.leadership.current();
            if (!lease) {
                await this.sleep(this.config.leadershipWaitMs);
                continue;
            }
            const result = await this.runSession(lease);
            if (this.stopped || result.reason === 'shutdown') break;
            this.countReconnect(result.reason);
            if (result.reason === 'leadership_lost') {
                attempt = 0;
                continue;
            }
            attempt = result.progressed ? 1 : attempt + 1;
            const delay = reconnectDelayMs(result.reason, attempt, this.config, this.random, result.retryHintMs);
            logger.info({ reason: result.reason, attempt, delayMs: delay }, 'Satellite stream will reconnect');
            await this.sleep(delay);
        }
    }

    private async runSession(
        lease: LeaseToken
    ): Promise<{ reason: ReconnectReason; progressed: boolean; retryHintMs: number | null }> {
        const session: Session = {
            lease,
            controller: new AbortController(),
            correlationId: randomUUID(),
            reason: null,
            discard: false,
            parser: new SseParser({ maxEventBytes: this.config.maxEventBytes }),
            tracker: null,
            pending: [],
            flushing: Promise.resolve(),
            lingerTimer: undefined,
            idleTimer: undefined,
            retryHintMs: null,
            progressed: false,
            connected: false,
        };
        this.active = session;
        const log = { correlationId: session.correlationId, epoch: lease.epoch, instanceId: lease.ownerId };
        let failure: unknown;
        try {
            try {
                await this.writer.prepare(lease);
                const from = await this.writer.readCheckpoint();
                this.setDurable(from - 1);
                this.stats.currentFrom = from;
                session.tracker = new OffsetTracker<Received>(from - 1);
                if (session.controller.signal.aborted) return this.finish(session, failure);
                if (this.leadership.current()?.epoch !== lease.epoch) throw new LeaseLostError();
            } catch (error) {
                if (error instanceof LeaseLostError) throw error;
                throw new SatelliteWriteError(error);
            }

            const from = session.tracker.expected;
            const body = await this.client.openStream(from, {
                signal: session.controller.signal,
                correlationId: session.correlationId,
            });
            session.connected = true;
            satelliteStreamConnected.set(1);
            logger.info({ ...log, from }, 'Satellite stream connected');
            this.resetIdle(session);

            for await (const chunk of body) {
                if (session.controller.signal.aborted) break;
                await this.handleItems(session, session.parser.push(chunk));
            }
            for (const item of session.parser.end()) {
                if (item.type === 'incomplete') logger.warn({ ...log, bytes: item.bytes }, 'Stream ended mid-event');
            }
            if (!session.controller.signal.aborted) session.reason = 'eof';
        } catch (error) {
            failure = error;
        }
        return this.finish(session, failure);
    }

    private async finish(
        session: Session,
        failure: unknown
    ): Promise<{ reason: ReconnectReason; progressed: boolean; retryHintMs: number | null }> {
        const reason = session.reason ?? classifyStreamError(failure);
        session.reason = reason;
        this.clearTimers(session);
        if (!session.controller.signal.aborted) session.controller.abort();
        satelliteStreamConnected.set(0);

        if (reason === 'leadership_lost' || reason === 'shutdown' || reason === 'writer_error') session.discard = true;
        if (!session.discard) {
            try {
                await session.flushing.catch(() => undefined);
                await this.flush(session);
            } catch (error) {
                logger.warn({ error, correlationId: session.correlationId }, 'Final satellite flush failed');
            }
        } else {
            session.pending = [];
        }
        if (reason === 'leadership_lost') this.leadership.invalidate(session.lease);

        const level = reason === 'eof' || reason === 'manual' || reason === 'shutdown' ? 'info' : 'warn';
        const message = failure instanceof Error ? failure.message : null;
        if (message && reason !== 'leadership_lost') this.stats.lastError = `${reason}: ${message}`;
        logger[level](
            {
                reason,
                error: reason === 'network' || reason === 'writer_error' ? failure : undefined,
                detail: message,
                lastReceived: session.tracker?.last ?? null,
                lastDurable: this.stats.lastDurable,
                correlationId: session.correlationId,
                epoch: session.lease.epoch,
            },
            reason === 'leadership_lost' ? 'Satellite stream closed: leadership_lost' : 'Satellite stream closed'
        );
        if (this.active === session) this.active = null;
        return { reason, progressed: session.progressed, retryHintMs: session.retryHintMs };
    }

    private abortSession(session: Session, reason: ReconnectReason): void {
        if (session.reason === null) session.reason = reason;
        if (reason === 'leadership_lost' || reason === 'shutdown') session.discard = true;
        this.clearTimers(session);
        session.controller.abort();
    }

    private async handleItems(session: Session, items: SseItem[]): Promise<void> {
        for (const item of items) {
            if (session.controller.signal.aborted) return;
            const receivedAt = new Date().toISOString();
            switch (item.type) {
                case 'comment':
                    this.resetIdle(session);
                    break;
                case 'retry':
                    session.retryHintMs = item.ms;
                    break;
                case 'incomplete':
                    break;
                case 'oversized': {
                    this.resetIdle(session);
                    const offset = parseOffsetId(item.id);
                    const value: Received = {
                        ok: false,
                        error: payloadTooLarge(item.bytes, this.config.maxEventBytes),
                        payload: Buffer.from(
                            `id: ${item.id ?? ''}\n: event SSE melebihi ${this.config.maxEventBytes} byte; isi dibuang saat streaming (${item.bytes}+ byte terlihat)\n`
                        ),
                        receivedAt,
                    };
                    await this.place(session, offset, value);
                    break;
                }
                case 'event': {
                    this.resetIdle(session);
                    const decoded = decodeSatelliteEvent(item, { maxDepth: this.config.maxDepth });
                    const value: Received = decoded.ok
                        ? {
                              ok: true,
                              kind: decoded.kind,
                              dataText: decoded.dataText,
                              virtualNow: decoded.virtualNow,
                              receivedAt,
                          }
                        : { ok: false, error: decoded.error, payload: originalBlock(item), receivedAt };
                    await this.place(session, decoded.offset, value);
                    break;
                }
            }
        }
    }

    private async place(session: Session, offset: number | null, value: Received): Promise<void> {
        const tracker = session.tracker!;
        if (offset === null) {
            tracker.holdUnplaced(value);
            return;
        }
        const placement = tracker.accept(offset, value);
        if (placement.kind === 'duplicate') {
            this.stats.duplicates++;
            satelliteDuplicatesTotal.inc();
            logger.debug({ offset, correlationId: session.correlationId }, 'Dropped duplicate satellite offset');
            return;
        }
        if (placement.kind === 'gap') {
            this.stats.gaps++;
            satelliteGapsTotal.inc();
            logger.warn(
                { ...placement, correlationId: session.correlationId },
                'Satellite offset gap; reconnecting from the durable checkpoint'
            );
            throw new GapDetectedError(placement.expected, placement.received);
        }

        for (const orphan of placement.orphans) {
            session.pending.push({ record: null, dlq: this.dlqInput(session, null, orphan) });
        }
        for (const { offset: placed, value: received } of placement.placed) {
            session.pending.push(this.toPending(session, placed, received));
        }
        session.progressed = true;
        this.stats.lastReceived = tracker.last;
        satelliteLastOffsetReceived.set(tracker.last);

        if (session.pending.length >= this.config.batchMax) {
            await this.flush(session);
        } else if (!session.lingerTimer) {
            session.lingerTimer = setTimeout(() => {
                session.lingerTimer = undefined;
                this.flush(session).catch((error) => {
                    this.stats.lastError = `writer_error: ${error instanceof Error ? error.message : String(error)}`;
                    logger.warn({ error, correlationId: session.correlationId }, 'Background satellite flush failed');
                    this.abortSession(
                        session,
                        error instanceof LeaseLostError ? 'leadership_lost' : classifyStreamError(error)
                    );
                });
            }, this.config.batchLingerMs);
        }
    }

    private toPending(session: Session, offset: number, received: Received): PendingRecord {
        const base = { offset, receivedAt: received.receivedAt, correlationId: session.correlationId };
        if (received.ok) {
            this.countEvent(received.kind);
            if (received.kind === 'heartbeat' && received.virtualNow) {
                this.stats.lastHeartbeat = received.virtualNow;
                satelliteLastHeartbeatVirtualNow.set(Date.parse(received.virtualNow) / 1000);
            }
            return {
                record: { ...base, kind: received.kind, dataRaw: received.dataText, virtualNow: received.virtualNow },
                dlq: null,
            };
        }
        this.countEvent('unprocessed');
        return {
            record: { ...base, kind: 'unprocessed', reason: received.error.reason },
            dlq: this.dlqInput(session, offset, received),
        };
    }

    private dlqInput(session: Session, offset: number | null, received: Received): RecordUnprocessedInput | null {
        if (received.ok) return null;
        return {
            source: HazardSource.Satelit,
            context: { kind: SATELLITE_EVENT_KIND, endpoint: SATELLITE_STREAM_ENDPOINT, topic: null },
            payload: { kind: 'inline', bytes: received.payload },
            contentType: 'text/event-stream; charset=utf-8',
            correlationId: session.correlationId,
            sourceRefId: offset === null ? null : `offset:${offset}`,
            error: received.error,
        };
    }

    private flush(session: Session): Promise<void> {
        const run = session.flushing.then(() => this.flushNow(session));
        session.flushing = run.catch(() => undefined);
        return run;
    }

    private async flushNow(session: Session): Promise<void> {
        if (session.lingerTimer) {
            clearTimeout(session.lingerTimer);
            session.lingerTimer = undefined;
        }
        if (session.discard) {
            session.pending = [];
            return;
        }
        const batch = session.pending.splice(0);
        if (batch.length === 0) return;
        try {
            // DLQ first: if the append below fails, the replayed event maps to the same message_id (no duplicate).
            for (const entry of batch) {
                if (!entry.dlq) continue;
                const stored = await this.recorder.record(entry.dlq, session.lease);
                if (entry.record) entry.record.messageId = stored.messageId;
            }
            const records = batch.flatMap((entry) => (entry.record ? [entry.record] : []));
            if (records.length === 0) return;
            await this.writer.append(records, session.lease);
            this.setDurable(records[records.length - 1].offset);
        } catch (error) {
            if (error instanceof LeaseLostError) throw error;
            throw new SatelliteWriteError(error);
        }
    }

    private resetIdle(session: Session): void {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = setTimeout(() => this.abortSession(session, 'idle_timeout'), this.config.idleTimeoutMs);
    }

    private clearTimers(session: Session): void {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = undefined;
        if (session.lingerTimer && session.discard) {
            clearTimeout(session.lingerTimer);
            session.lingerTimer = undefined;
        }
    }

    private setDurable(offset: number): void {
        this.stats.lastDurable = offset;
        satelliteLastOffsetDurable.set(offset);
        satelliteLagInputs.durable = offset;
    }

    private resetLeaderGauges(): void {
        satelliteLatestOffset.set(0);
        satelliteLastOffsetDurable.set(0);
        satelliteLastOffsetReceived.set(0);
        satelliteLagInputs.latest = null;
        satelliteLagInputs.durable = null;
    }

    private countReconnect(reason: ReconnectReason): void {
        this.stats.reconnects[reason] = (this.stats.reconnects[reason] ?? 0) + 1;
        satelliteReconnectsTotal.inc({ reason });
    }

    private countEvent(type: string): void {
        this.stats.events[type] = (this.stats.events[type] ?? 0) + 1;
        satelliteEventsTotal.inc({ type });
    }

    private sleep(ms: number): Promise<void> {
        if (this.stopped) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            function done() {
                clearTimeout(timer);
                resolve();
            }
            this.wakeUp = () => {
                this.wakeUp = null;
                done();
            };
        });
    }

    private wake(): void {
        this.wakeUp?.();
    }

    private schedulePoll(delay: number): void {
        if (this.stopped) return;
        this.pollTimer = setTimeout(
            () => void this.pollSession().finally(() => this.schedulePoll(this.config.sessionPollMs)),
            delay
        );
    }

    private async pollSession(): Promise<void> {
        if (!this.leadership.current()) return;
        try {
            const session = await this.client.getSession({
                signal: AbortSignal.timeout(Math.max(1_000, this.config.sessionPollMs)),
                correlationId: randomUUID(),
            });
            this.stats.speed = session.speed;
            if (session.latestOffset !== null && this.leadership.current()) {
                this.stats.latestOffset = session.latestOffset;
                satelliteLatestOffset.set(session.latestOffset);
                satelliteLagInputs.latest = session.latestOffset;
            }
            // Heartbeats were observed every ~16 virtual minutes; at `speed` that is 960 s / speed of wall time.
            if (session.speed && !this.warnedIdleTimeout) {
                const heartbeatWallMs = (960 * 1000) / session.speed;
                if (heartbeatWallMs * 1.5 > this.config.idleTimeoutMs) {
                    this.warnedIdleTimeout = true;
                    logger.warn(
                        { speed: session.speed, heartbeatWallMs, idleTimeoutMs: this.config.idleTimeoutMs },
                        'SATELLITE_IDLE_TIMEOUT_MS is shorter than the expected heartbeat interval at this speed'
                    );
                }
            }
        } catch (error) {
            satelliteSessionPollErrorsTotal.inc();
            logger.warn({ error }, 'GET /v1/session failed');
        }
    }
}

function originalBlock(item: SseEventItem): Buffer {
    const head = Buffer.from(`${item.id !== null ? `id: ${item.id}\n` : ''}event: ${item.event}\n`);
    const lines: Buffer[] = [head];
    let start = 0;
    for (let i = 0; i <= item.data.length; i++) {
        if (i === item.data.length || item.data[i] === 0x0a) {
            lines.push(Buffer.from('data: '), item.data.subarray(start, i), Buffer.from('\n'));
            start = i + 1;
        }
    }
    return Buffer.concat(lines);
}
