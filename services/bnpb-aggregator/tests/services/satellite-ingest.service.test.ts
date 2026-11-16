import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { ISatelliteFeedClient, SatelliteHttpError, SatelliteSession } from '../../src/clients/satellite.client';
import { LeaseLostError, LeaseToken } from '../../src/db/schema/background-leases';
import { RecordUnprocessedInput, RecordUnprocessedResult } from '../../src/repositories/unprocessed-message.repository';
import { IBackgroundLeadershipService, LeadershipListener } from '../../src/services/background-leadership.service';
import {
    classifyStreamError,
    GapDetectedError,
    reconnectDelayMs,
    SatelliteIngestConfig,
    SatelliteIngestService,
    SatelliteWriteError,
} from '../../src/services/satellite-ingest.service';
import {
    assertConsecutive,
    ISatelliteLogWriter,
    SatelliteRawRecord,
} from '../../src/services/satellite-log-writer.service';
import { IUnprocessedRecorder } from '../../src/services/unprocessed-recorder.service';

// ------------------------------------------------------------------ fakes

class FakeLeadership implements IBackgroundLeadershipService {
    readonly instanceId = 'test-instance';
    private token: LeaseToken | null;
    private readonly listeners = new Set<LeadershipListener>();
    readonly invalidated: LeaseToken[] = [];

    constructor(epoch: number | null) {
        this.token = epoch === null ? null : { ownerId: this.instanceId, epoch };
    }

    start(): void {}
    async stop(): Promise<void> {}
    current(): LeaseToken | null {
        return this.token ? { ...this.token } : null;
    }
    set(epoch: number | null): void {
        this.token = epoch === null ? null : { ownerId: this.instanceId, epoch };
        for (const listener of this.listeners) listener(this.current());
    }
    invalidate(token: LeaseToken): void {
        this.invalidated.push(token);
        if (this.token?.epoch === token.epoch) this.set(null);
    }
    onChange(listener: LeadershipListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

/** Committed log + checkpoint, with the same contiguity rule the real broker-side writer enforces. */
class FakeWriter implements ISatelliteLogWriter {
    readonly log: SatelliteRawRecord[] = [];
    readonly prepared: number[] = [];
    nextWhenEmpty = 0;
    failNext: Error | null = null;
    appends = 0;

    constructor(private readonly leadership: FakeLeadership) {}

    async prepare(lease: LeaseToken): Promise<void> {
        this.prepared.push(lease.epoch);
    }
    async readCheckpoint(): Promise<number> {
        return this.log.length ? this.log[this.log.length - 1].offset + 1 : this.nextWhenEmpty;
    }
    async append(records: SatelliteRawRecord[], lease: LeaseToken): Promise<void> {
        this.appends++;
        if (this.failNext) {
            const error = this.failNext;
            this.failNext = null;
            throw error;
        }
        if (this.leadership.current()?.epoch !== lease.epoch) throw new LeaseLostError();
        assertConsecutive(records);
        const expected = await this.readCheckpoint();
        if (records[0].offset !== expected) throw new Error(`append at ${records[0].offset}, expected ${expected}`);
        this.log.push(...records.map((r) => ({ ...r })));
    }
    async close(): Promise<void> {}
    offsets(): number[] {
        return this.log.map((r) => r.offset);
    }
}

class FakeRecorder implements IUnprocessedRecorder {
    readonly entries = new Map<string, RecordUnprocessedInput>();
    calls = 0;
    async record(input: RecordUnprocessedInput): Promise<RecordUnprocessedResult> {
        this.calls++;
        const bytes = input.payload.kind === 'inline' ? input.payload.bytes : Buffer.alloc(0);
        const messageId = `msg-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
        const created = !this.entries.has(messageId);
        this.entries.set(messageId, input);
        return { messageId, created, reopened: false, status: 'parked' };
    }
}

type Step = string | Buffer | (() => Promise<void>);
type Script = { status: number; code?: string } | { steps: Step[]; end: 'eof' | 'hang' | 'reset' };

const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeFeed implements ISatelliteFeedClient {
    readonly froms: number[] = [];
    readonly signals: AbortSignal[] = [];
    readonly openedAt: number[] = [];
    open = 0;
    maxOpen = 0;
    constructor(private readonly scripts: Script[]) {}

    async getSession(): Promise<SatelliteSession> {
        return { profile: 'test', group: 'g', speed: 60, latestOffset: null, virtualNow: null };
    }

    async openStream(from: number, options: { signal: AbortSignal }): Promise<AsyncIterable<Uint8Array>> {
        this.froms.push(from);
        this.openedAt.push(Date.now());
        const script = this.scripts.shift() ?? { steps: [], end: 'hang' };
        if ('status' in script) throw new SatelliteHttpError(script.status, script.code ?? null, null);
        const stream: Extract<Script, { steps: Step[] }> = script;
        const { signal } = options;
        this.signals.push(signal);
        this.open++;
        this.maxOpen = Math.max(this.maxOpen, this.open);
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const feed = this;
        async function* body(): AsyncGenerator<Uint8Array> {
            try {
                for (const step of stream.steps) {
                    if (signal.aborted) throw abortError();
                    if (typeof step === 'function') {
                        await step();
                        continue;
                    }
                    await tick();
                    yield Buffer.isBuffer(step) ? step : Buffer.from(step);
                }
                if (stream.end === 'eof') return;
                if (stream.end === 'reset') throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
                await new Promise<void>((_resolve, reject) => {
                    if (signal.aborted) return reject(abortError());
                    signal.addEventListener('abort', () => reject(abortError()), { once: true });
                });
            } finally {
                feed.open--;
            }
        }
        return body();
    }
}

// ------------------------------------------------------------------ helpers

const detection = (offset: number) =>
    `id: ${offset}\nevent: detection\ndata: {"offset":${offset},"detection":{"version":"2.0NRT","acq_date":"2026-11-14","acq_time":2350,"confidence":"n","frp":11.70,"latitude":-8.35726,"longitude":122.48591,"satellite":"N21"}}\n\n`;
const heartbeat = (offset: number, virtualNow: string) =>
    `id: ${offset}\r\nevent: heartbeat\r\ndata: {"offset":${offset},"virtual_now":"${virtualNow}"}\r\n\r\n`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const detections = (from: number, to: number) => range(from, to).map(detection);

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('condition not reached in time');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const FAST: Partial<SatelliteIngestConfig> = {
    enabled: true,
    batchMax: 3,
    batchLingerMs: 5,
    maxEventBytes: 4096,
    idleTimeoutMs: 2_000,
    sessionPollMs: 600_000,
    backoffBaseMs: 1,
    backoffCapMs: 5,
    backoff429BaseMs: 1,
    backoff429CapMs: 5,
    authBackoffMs: 5,
    quickReconnectMs: 1,
    leadershipWaitMs: 5,
};

function setup(scripts: Script[], options: { epoch?: number | null; config?: Partial<SatelliteIngestConfig> } = {}) {
    const leadership = new FakeLeadership(options.epoch === undefined ? 1 : options.epoch);
    const writer = new FakeWriter(leadership);
    const recorder = new FakeRecorder();
    const feed = new FakeFeed(scripts);
    const service = new SatelliteIngestService(feed, writer, leadership, recorder);
    service.configure({ ...FAST, ...options.config }, () => 0.5);
    return { leadership, writer, recorder, feed, service };
}

let running: SatelliteIngestService | undefined;
afterEach(async () => {
    await running?.stop();
    running = undefined;
});

function start(service: SatelliteIngestService) {
    running = service;
    service.start();
}

// ------------------------------------------------------------------ scenarios

describe('SatelliteIngestService — scenario A: normal start', () => {
    it('starts at from=0 on an empty log and writes every event, heartbeat included', async () => {
        const { service, writer, feed } = setup([
            { steps: [...detections(0, 4), heartbeat(5, '2026-11-15T00:16:00Z'), detection(6)], end: 'hang' },
        ]);
        start(service);
        await waitFor(() => writer.log.length === 7);
        expect(feed.froms).toEqual([0]);
        expect(writer.offsets()).toEqual(range(0, 6));
        expect(writer.log[5]).toMatchObject({ kind: 'heartbeat', virtualNow: '2026-11-15T00:16:00Z' });
        expect(writer.log[0].dataRaw).toContain('"frp":11.70'); // raw text, not re-serialised
        expect(service.status()).toMatchObject({
            connected: true,
            last_offset_received: 6,
            last_offset_durable: 6,
            last_heartbeat_virtual_now: '2026-11-15T00:16:00Z',
            events: { detection: 6, heartbeat: 1 },
        });
    });

    it('resumes at from=42 when offsets up to 41 are durable', async () => {
        const { service, writer, feed } = setup([{ steps: detections(42, 44), end: 'hang' }]);
        writer.nextWhenEmpty = 42;
        start(service);
        await waitFor(() => writer.log.length === 3);
        expect(feed.froms).toEqual([42]);
    });

    it('stays idle without leadership and never opens a stream', async () => {
        const { service, feed, leadership } = setup([{ steps: detections(0, 0), end: 'hang' }], { epoch: null });
        start(service);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(feed.froms).toEqual([]);
        leadership.set(3);
        await waitFor(() => feed.froms.length === 1);
    });

    it('does nothing when disabled', async () => {
        const { service, feed } = setup([], { config: { enabled: false } });
        start(service);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(feed.froms).toEqual([]);
    });
});

describe('SatelliteIngestService — scenario B: reconnect after the connection drops', () => {
    it('flushes complete events, reconnects from the broker checkpoint and drops replayed offsets', async () => {
        // Linger is long: offsets 3..5 are only pending when the connection resets, the final flush makes them durable.
        const { service, writer, feed } = setup(
            [
                { steps: detections(0, 5), end: 'reset' },
                { steps: detections(4, 9), end: 'hang' }, // server replays 4,5
            ],
            { config: { batchMax: 3, batchLingerMs: 60_000 } }
        );
        start(service);
        await waitFor(() => writer.log.length === 9);
        expect(feed.froms).toEqual([0, 6]);
        expect(writer.offsets()).toEqual(range(0, 8));
        expect(service.status()).toMatchObject({ duplicates: 2, gaps: 0, reconnects: { network: 1 } });
    });

    it('detects a gap, keeps what came before it and reconnects from the missing offset', async () => {
        const { service, writer, feed } = setup([
            { steps: [detection(0), detection(1), detection(3)], end: 'hang' },
            { steps: detections(2, 4), end: 'hang' },
        ]);
        start(service);
        await waitFor(() => writer.log.length === 5);
        expect(feed.froms).toEqual([0, 2]);
        expect(writer.offsets()).toEqual(range(0, 4));
        expect(service.status()).toMatchObject({ gaps: 1, reconnects: { gap: 1 } });
    });

    it('reconnects after an idle timeout (no event or comment for X ms)', async () => {
        const { service, writer, feed } = setup(
            [
                { steps: [detection(0)], end: 'hang' },
                { steps: [detection(1)], end: 'hang' },
            ],
            { config: { idleTimeoutMs: 60 } }
        );
        start(service);
        await waitFor(() => writer.log.length === 2);
        expect(feed.froms.slice(0, 2)).toEqual([0, 1]);
        expect(service.status().reconnects.idle_timeout).toBeGreaterThanOrEqual(1);
    });

    it('treats SSE comments as liveness', async () => {
        const keepalives = Array.from({ length: 6 }, () => [
            () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
            ': keepalive\n\n',
        ]).flat();
        const { service, feed } = setup([{ steps: [detection(0), ...keepalives], end: 'hang' }], {
            config: { idleTimeoutMs: 60 },
        });
        start(service);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(feed.froms).toEqual([0]);
    });

    it('drops the connection on request (manual) and resumes', async () => {
        const { service, writer, feed } = setup([
            { steps: detections(0, 2), end: 'hang' },
            { steps: detections(3, 4), end: 'hang' },
        ]);
        start(service);
        await waitFor(() => writer.log.length === 3);
        expect(service.disconnect()).toBe(true);
        await waitFor(() => writer.log.length === 5);
        expect(feed.froms).toEqual([0, 3]);
        expect(service.status().reconnects).toMatchObject({ manual: 1 });
    });

    it('re-reads the checkpoint after a failed durable write: no loss, no duplicate', async () => {
        const { service, writer, feed } = setup([
            { steps: detections(0, 5), end: 'hang' },
            { steps: detections(3, 7), end: 'hang' },
        ]);
        let failed = false;
        const append = writer.append.bind(writer);
        writer.append = async (records, lease) => {
            if (!failed && records[0].offset === 3) {
                failed = true;
                throw new Error('kafka unavailable');
            }
            return append(records, lease);
        };
        start(service);
        await waitFor(() => writer.log.length === 8);
        expect(feed.froms).toEqual([0, 3]);
        expect(writer.offsets()).toEqual(range(0, 7));
        expect(service.status().reconnects).toMatchObject({ writer_error: 1 });
    });
});

describe('SatelliteIngestService — scenario C: leader failover', () => {
    it('closes the stream synchronously on leadership loss, discards uncommitted events, new epoch resumes', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const { service, writer, feed, leadership } = setup(
            [
                { steps: [...detections(0, 3), () => gate, detection(4), detection(5)], end: 'hang' },
                { steps: detections(4, 7), end: 'hang' }, // a full batch, flushed at once
            ],
            { config: { batchMax: 4, batchLingerMs: 60_000 } }
        );
        start(service);
        await waitFor(() => writer.log.length === 4); // 0..3 durable (batchMax)
        release();
        await waitFor(() => service.status().last_offset_received === 5); // 4,5 received, still pending
        const appendsBefore = writer.appends;

        leadership.set(null); // lease lost
        expect(feed.signals[0].aborted).toBe(true); // closed SEGERA, inside the listener
        await waitFor(() => feed.open === 0);
        expect(writer.appends).toBe(appendsBefore); // pending 4,5 were not written without a lease

        leadership.set(2); // this instance wins the next election (or another one, same broker state)
        await waitFor(() => writer.log.length === 8);
        expect(writer.prepared).toEqual([1, 2]); // fenced again for the new epoch
        expect(feed.froms).toEqual([0, 4]);
        expect(writer.offsets()).toEqual(range(0, 7));
        expect(service.status().reconnects).toMatchObject({ leadership_lost: 1 });
    });

    it('a fenced write (zombie) stops the stream and gives up leadership', async () => {
        const { service, writer, feed, leadership } = setup([{ steps: detections(0, 2), end: 'hang' }]);
        writer.failNext = new LeaseLostError();
        start(service);
        await waitFor(() => leadership.current() === null);
        await waitFor(() => feed.open === 0);
        expect(writer.log).toEqual([]);
        expect(leadership.invalidated.map((t) => t.epoch)).toEqual([1]);
    });

    it('never holds two streams at once, also across many reconnects', async () => {
        const scripts: Script[] = [];
        for (let i = 0; i < 10; i++) scripts.push({ steps: [detection(i)], end: i % 2 ? 'reset' : 'eof' });
        const { service, writer, feed } = setup(scripts);
        start(service);
        await waitFor(() => writer.log.length === 10);
        expect(feed.maxOpen).toBe(1);
        expect(feed.froms.slice(0, 10)).toEqual(range(0, 9));
    });
});

describe('SatelliteIngestService — HTTP errors', () => {
    it('retries 429 until the old connection is gone', async () => {
        const { service, writer, feed } = setup([
            { status: 429, code: 'too_many_connections' },
            { status: 429, code: 'too_many_connections' },
            { steps: detections(0, 1), end: 'hang' },
        ]);
        start(service);
        await waitFor(() => writer.log.length === 2);
        expect(feed.froms).toEqual([0, 0, 0]);
        expect(service.status().reconnects).toMatchObject({ http_429: 2 });
    });

    it('waits the long configuration backoff after 401', async () => {
        const { service, feed } = setup(
            [
                { status: 401, code: 'unauthorized' },
                { steps: [], end: 'hang' },
            ],
            {
                config: { authBackoffMs: 150 },
            }
        );
        start(service);
        await waitFor(() => feed.froms.length === 2);
        expect(feed.openedAt[1] - feed.openedAt[0]).toBeGreaterThanOrEqual(140);
        expect(service.status().reconnects).toMatchObject({ http_401: 1 });
        expect(service.status().last_error).toContain('401');
    });

    it('backs off on 503', async () => {
        const { service, writer } = setup([{ status: 503 }, { status: 503 }, { steps: detections(0, 0), end: 'hang' }]);
        start(service);
        await waitFor(() => writer.log.length === 1);
        expect(service.status().reconnects).toMatchObject({ http_503: 2 });
    });
});

describe('SatelliteIngestService — broken events', () => {
    it('stores a broken event in the DLQ and keeps its offset as an unprocessed record', async () => {
        const broken = 'id: 1\nevent: detection\ndata: {"offset":1,"detection":{"satel\n\n';
        const { service, writer, recorder } = setup([{ steps: [detection(0), broken, detection(2)], end: 'hang' }]);
        start(service);
        await waitFor(() => writer.log.length === 3);
        expect(writer.offsets()).toEqual([0, 1, 2]);
        const record = writer.log[1];
        expect(record).toMatchObject({
            kind: 'unprocessed',
            reason: expect.stringMatching(/^malformed_json: JSON terpotong/),
        });
        const entry = recorder.entries.get(record.messageId!)!;
        expect(entry).toMatchObject({
            source: 'SATELIT',
            sourceRefId: 'offset:1',
            context: { kind: 'stream.event', endpoint: 'GET /v1/stream', topic: null },
        });
        expect(entry.payload.kind === 'inline' && entry.payload.bytes.toString()).toBe(
            'id: 1\nevent: detection\ndata: {"offset":1,"detection":{"satel\n'
        );
        expect(service.status().events).toMatchObject({ detection: 2, unprocessed: 1 });
    });

    it('places a broken block without any offset between two good ones', async () => {
        const junk = 'event: detection\ndata: \u0000garbage\n\n';
        const { service, writer, recorder } = setup([{ steps: [detection(0), junk, detection(2)], end: 'hang' }]);
        start(service);
        await waitFor(() => writer.log.length === 3);
        expect(writer.log.map((r) => r.kind)).toEqual(['detection', 'unprocessed', 'detection']);
        expect([...recorder.entries.values()][0].sourceRefId).toBe('offset:1');
    });

    it('records an oversized event without buffering it and continues', async () => {
        const huge = `id: 1\nevent: detection\ndata: ${'x'.repeat(10_000)}\n\n`;
        const { service, writer, recorder } = setup([{ steps: [detection(0), huge, detection(2)], end: 'hang' }]);
        start(service);
        await waitFor(() => writer.log.length === 3);
        expect(writer.log[1]).toMatchObject({
            kind: 'unprocessed',
            reason: expect.stringMatching(/^payload_too_large/),
        });
        expect(recorder.calls).toBe(1);
    });

    it('re-receiving the same broken event after a reconnect does not duplicate the DLQ entry', async () => {
        const broken = 'id: 1\nevent: detection\ndata: {oops\n\n';
        const { service, writer, recorder } = setup([
            { steps: [detection(0), broken], end: 'reset' },
            { steps: [detection(0), broken, detection(2)], end: 'hang' }, // replays from the checkpoint
        ]);
        // Fail the first append that contains offset 1 so the event is fetched again.
        let failed = false;
        const append = writer.append.bind(writer);
        writer.append = async (records, lease) => {
            if (!failed && records.some((r) => r.offset === 1)) {
                failed = true;
                throw new Error('kafka down');
            }
            return append(records, lease);
        };
        start(service);
        await waitFor(() => writer.log.length === 3);
        expect(recorder.calls).toBe(2);
        expect(recorder.entries.size).toBe(1);
        expect(writer.offsets()).toEqual([0, 1, 2]);
    });
});

// ------------------------------------------------------------------ pure helpers

describe('reconnectDelayMs', () => {
    const config = {
        backoffBaseMs: 1_000,
        backoffCapMs: 60_000,
        backoff429BaseMs: 2_000,
        backoff429CapMs: 30_000,
        authBackoffMs: 300_000,
        quickReconnectMs: 250,
    } as SatelliteIngestConfig;
    const max = () => 1; // upper end of the jitter

    it.each([
        ['http_401', 1, 300_000],
        ['http_400', 3, 300_000],
        ['http_429', 1, 2_000],
        ['http_429', 3, 8_000],
        ['http_429', 10, 30_000],
        ['http_503', 1, 1_000],
        ['http_503', 4, 8_000],
        ['http_503', 20, 60_000],
        ['network', 2, 2_000],
        ['gap', 1, 250],
        ['manual', 1, 250],
        ['idle_timeout', 3, 2_000],
        ['leadership_lost', 5, 0],
    ] as const)('%s attempt %d → %d ms', (reason, attempt, expected) => {
        expect(reconnectDelayMs(reason, attempt, config, max)).toBe(expected);
    });

    it('adds jitter (equal jitter: between half and full ceiling)', () => {
        expect(reconnectDelayMs('http_429', 3, config, () => 0)).toBe(4_000);
        expect(reconnectDelayMs('http_503', 4, config, () => 0)).toBe(4_000);
    });

    it('honours the server retry hint for eof', () => {
        expect(reconnectDelayMs('eof', 1, config, max, 3_000)).toBe(3_000);
    });
});

describe('classifyStreamError', () => {
    it.each([
        [new SatelliteHttpError(400, 'bad_request', null), 'http_400'],
        [new SatelliteHttpError(401, 'unauthorized', null), 'http_401'],
        [new SatelliteHttpError(429, 'too_many_connections', null), 'http_429'],
        [new SatelliteHttpError(503, 'unavailable', null), 'http_503'],
        [new SatelliteHttpError(502, null, null), 'http_5xx'],
        [new SatelliteHttpError(404, null, null), 'http_other'],
        [new LeaseLostError(), 'leadership_lost'],
        [new SatelliteWriteError(new Error('x')), 'writer_error'],
        [new GapDetectedError(3, 5), 'gap'],
        [new TypeError('fetch failed'), 'network'],
    ])('%s → %s', (error, reason) => {
        expect(classifyStreamError(error)).toBe(reason);
    });
});
