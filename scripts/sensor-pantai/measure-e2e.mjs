import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Measurement } from './measurement.mjs';

function iso(value) {
    if (typeof value !== 'string') return false;
    const match = /^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)$/.exec(
        value
    );
    if (!match) return false;
    const day = Date.parse(`${match[1]}T00:00:00Z`);
    return (
        Number.isFinite(day) &&
        new Date(day).toISOString().slice(0, 10) === match[1] &&
        Number.isFinite(Date.parse(value))
    );
}
const text = (value, max = 255) => typeof value === 'string' && value.length > 0 && value.length <= max;

export function validObservation(item, generatedAt, stations, maxBytes = 8192, maxFutureMs = 30000) {
    return (
        item !== null &&
        typeof item === 'object' &&
        text(item.observation_id) &&
        stations.has(item.station_id) &&
        iso(item.observed_at) &&
        Date.parse(item.observed_at) <= Date.parse(generatedAt) + maxFutureMs &&
        Number.isFinite(item.sea_level_anomaly_m) &&
        Number.isFinite(item.wave_height_m) &&
        item.wave_height_m >= 0 &&
        text(item.quality, 64) &&
        typeof item.critical === 'boolean' &&
        Buffer.byteLength(JSON.stringify(item)) <= maxBytes
    );
}

export async function runMeasurement(
    options,
    { fetchFn = fetch, now = () => performance.now(), pause = delay, shouldStop = () => false } = {}
) {
    const model = new Measurement();
    const rejected = new Set();
    let stations;
    let stationsAt = -Infinity;
    let nextSensorRequestAt = 0;
    let sourceCursor = null;
    let sensorQueue = Promise.resolve();
    const sourceScans = { full: 0, incremental: 0 };
    const requests = { sensor: 0, audit: 0, notification: 0 };

    async function requestJson(endpoint, path, query = {}) {
        if (endpoint === 'sensor') {
            await pause(Math.max(0, nextSensorRequestAt - now()));
            nextSensorRequestAt = now() + options.intervalMs;
        }
        const url = new URL(path, options[`${endpoint}Url`]);
        for (const [key, value] of Object.entries(query)) if (value !== null) url.searchParams.set(key, value);
        const token = endpoint === 'sensor' ? options.sensorToken : endpoint === 'audit' ? options.auditToken : null;
        requests[endpoint]++;
        let response;
        try {
            response = await fetchFn(url, {
                headers: { 'User-Agent': 'bnpb-p5-observer', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                signal: AbortSignal.timeout(options.timeoutMs),
                redirect: 'error',
            });
            if (!response.ok) {
                await response.body?.cancel();
                const retryMs = Number(response.headers.get('retry-after')) * 1000;
                if (endpoint === 'sensor') nextSensorRequestAt = now() + Math.max(3000, Math.min(60000, retryMs || 0));
                throw new Error(`HTTP ${response.status}`);
            }
            let size = 0;
            const chunks = [];
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 16 * 1024 * 1024) throw new Error('response exceeds 16 MiB');
                chunks.push(chunk);
            }
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch (error) {
            if (endpoint === 'sensor') nextSensorRequestAt = Math.max(nextSensorRequestAt, now() + 3000);
            if (response && !response.ok) throw error;
            throw new Error('request, response size or JSON validation failed');
        }
    }

    function json(endpoint, path, query = {}) {
        if (endpoint !== 'sensor') return requestJson(endpoint, path, query);
        const request = sensorQueue.then(() => requestJson(endpoint, path, query));
        sensorQueue = request.catch(() => undefined);
        return request;
    }

    async function pages(endpoint, path, params = {}, initialCursor = null) {
        let cursor = initialCursor;
        let bytes = 0;
        const seen = new Set(initialCursor === null ? [] : [initialCursor]);
        const result = [];
        for (let page = 0; page < options.maxPages; page++) {
            const body = await json(endpoint, path, { ...params, limit: '1000', cursor });
            bytes += Buffer.byteLength(JSON.stringify(body));
            if (bytes > 16 * 1024 * 1024) throw new Error('snapshot exceeds 16 MiB; result is incomplete');
            if (
                !Array.isArray(body.items) ||
                body.items.length > 2000 ||
                !(body.next_cursor === null || text(body.next_cursor, 4096))
            )
                throw new Error('invalid pagination envelope');
            if (body.partial === true || (endpoint === 'audit' && body.partial !== false))
                throw new Error(`partial ${endpoint} response`);
            if (endpoint === 'sensor' && !iso(body.generated_at)) throw new Error('invalid generated_at');
            result.push(body);
            // The live sensor retains a resume cursor at its tail; a short page bounds this scan.
            if (body.next_cursor === null || (endpoint === 'sensor' && body.items.length < 1000))
                return { bodies: result, cursor };
            if (seen.has(body.next_cursor)) throw new Error('cursor cycle');
            seen.add(body.next_cursor);
            cursor = body.next_cursor;
        }
        throw new Error('pagination limit exceeded; result is incomplete');
    }

    async function readStations() {
        const body = await json('sensor', '/v1/stations');
        if (
            !Array.isArray(body.items) ||
            body.items.length > 1000 ||
            body.items.some(
                (s) =>
                    !text(s.station_id) ||
                    !text(s.name) ||
                    !text(s.province) ||
                    !Number.isFinite(s.latitude) ||
                    Math.abs(s.latitude) > 90 ||
                    !Number.isFinite(s.longitude) ||
                    Math.abs(s.longitude) > 180
            )
        )
            throw new Error('invalid stations');
        stations = new Set(body.items.map((s) => s.station_id));
        if (stations.size !== body.items.length) throw new Error('duplicate station IDs');
        stationsAt = now();
    }

    async function readSource({ full = false, baseline = false } = {}) {
        sourceScans[full ? 'full' : 'incremental']++;
        const start = now();
        if (!stations || now() - stationsAt >= 60000) await readStations();
        const { bodies: snapshots, cursor } = await pages('sensor', '/v1/observations', {}, full ? null : sourceCursor);
        if (
            snapshots.some((page) =>
                page.items.some((item) => item && text(item.station_id) && !stations.has(item.station_id))
            )
        )
            await readStations();
        const items = new Map();
        for (const page of snapshots)
            for (const item of page.items) {
                if (validObservation(item, page.generated_at, stations, options.maxRecordBytes, options.maxFutureMs)) {
                    const old = items.get(item.observation_id);
                    if (old && JSON.stringify(old) !== JSON.stringify(item))
                        model.issues.add('conflicting_source_duplicates');
                    items.set(item.observation_id, item);
                } else rejected.add(createHash('sha256').update(JSON.stringify(item)).digest('hex'));
            }
        const generatedAt = snapshots.reduce((max, page) => Math.max(max, Date.parse(page.generated_at)), -Infinity);
        const observedAt = [...items.values()].reduce(
            (max, item) => Math.max(max, Date.parse(item.observed_at)),
            -Infinity
        );
        const frame = {
            start,
            end: now(),
            generatedAt,
            incremental: !full,
            behindSourceClock: items.size > 0 && generatedAt - observedAt > (options.maxSourceLagMs ?? 120000),
        };
        if (!full || baseline) {
            model.source([...items.values()], frame, baseline);
            sourceCursor = cursor;
        }
        return { items: [...items.values()], frame };
    }

    async function capture(endpoint, work) {
        try {
            const result = await work();
            model.healthy[endpoint] = true;
            return result;
        } catch (error) {
            if (endpoint === 'sensor') nextSensorRequestAt = Math.max(nextSensorRequestAt, now() + 3000);
            model.failure(endpoint, error.message);
        }
    }
    const auditNeeded = () => [...model.expected.keys()].some((id) => !model.hazards.has(id));
    const inboxNeeded = () => [...model.expected.keys()].some((id) => !model.inbox.has(model.hazards.get(id)));
    async function readAudit() {
        if (!auditNeeded()) return;
        await capture('audit', async () => {
            const { bodies } = await pages('audit', '/internal/audit/events', { source: 'SENSOR_PANTAI' });
            const items = bodies.flatMap((page) => page.items);
            if (
                items.some(
                    (item) => item.source !== 'SENSOR_PANTAI' || !text(item.source_ref_id) || !text(item.hazard_id)
                )
            )
                throw new Error('invalid audit items');
            model.audit(items);
        });
    }
    async function readInbox() {
        if (!inboxNeeded()) return;
        await capture('notification', async () => {
            const start = now();
            const body = await json('notification', '/api/notifications');
            if (body.partial === true || body.meta?.partial === true || body.next_cursor != null)
                throw new Error('incomplete notification response');
            if (!Array.isArray(body.data) || body.data.some((item) => !text(item.hazardId) || !text(item.eventId)))
                throw new Error('invalid notification response');
            model.notifications(body.data, { start, end: now() });
        });
    }

    await readSource({ full: true, baseline: true });
    // Warm the retained tail before starting the timer, excluding the cost of scanning old history.
    await readSource({ baseline: true });
    model.healthy.sensor = true;
    let collecting = true;
    let sampling = true;
    async function loop(active, work) {
        while (active()) {
            await work();
            if (active()) await pause(options.intervalMs);
        }
    }
    const collectionStarted = now();
    const sourceTask = loop(
        () => collecting,
        () => capture('sensor', () => readSource())
    );
    const auditTask = loop(() => sampling, readAudit);
    const inboxTask = loop(() => sampling, readInbox);
    let collectionMs;
    let drainMs;
    try {
        while (!shouldStop() && now() - collectionStarted < options.durationMs) await pause(options.intervalMs);
        const knownAtVerification = new Set(model.known.keys());
        const verification = await capture('sensor', () => readSource({ full: true }));
        if (!verification) model.issues.add('source_verification_failed');
        collecting = false;
        await sourceTask;
        await capture('sensor', () => readSource());
        if (verification) model.verifySource(verification.items, verification.frame, knownAtVerification);
        collectionMs = now() - collectionStarted;
        const drainStarted = now();
        while (inboxNeeded() && now() - drainStarted < options.drainMs) await pause(options.intervalMs);
        drainMs = now() - drainStarted;
    } finally {
        collecting = false;
        sampling = false;
        await Promise.all([sourceTask, auditTask, inboxTask]);
    }
    return { ...model.report(), collectionMs, drainMs, requests, sourceScans, rejectedPayloads: rejected.size };
}

async function main() {
    const { values } = parseArgs({
        options: {
            'duration-seconds': { type: 'string', default: '300' },
            'drain-seconds': { type: 'string', default: '15' },
            'interval-ms': { type: 'string', default: '500' },
            'timeout-ms': { type: 'string', default: '3000' },
            'max-pages': { type: 'string', default: '64' },
            output: { type: 'string', default: 'test-results/sensor-pantai/measurement.json' },
            'sensor-url': { type: 'string' },
            'aggregator-url': { type: 'string' },
            'notification-url': { type: 'string' },
            help: { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log(
            'Usage: bash scripts/sensor-pantai/measure-e2e.sh [--duration-seconds 300] [--drain-seconds 15] [--interval-ms 500] [--output path]\nURL overrides: --sensor-url, --aggregator-url, --notification-url. Uses existing root .env credentials. Exit 0=pass, 1=failed target, 2=inconclusive/configuration error.'
        );
        return;
    }
    const integer = (name, min, max) => {
        const value = Number(values[name]);
        if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid --${name}`);
        return value;
    };
    const options = {
        sensorUrl:
            values['sensor-url'] ??
            process.env.SENSOR_URL ??
            `http://localhost:${process.env.SENSOR_PANTAI_HOST_PORT ?? 8083}`,
        auditUrl:
            values['aggregator-url'] ??
            process.env.AGGREGATOR_URL ??
            `http://localhost:${process.env.BNPB_AGGREGATOR_HOST_PORT ?? 3003}`,
        notificationUrl:
            values['notification-url'] ??
            process.env.NOTIFICATION_URL ??
            `http://localhost:${process.env.NOTIFICATION_CONSUMER_HOST_PORT ?? 3005}`,
        sensorToken: process.env.SENSOR_TOKEN ?? process.env.PANTAI_AUTH_TOKEN,
        auditToken: process.env.BNPB_AUDIT_TOKEN ?? process.env.BNPB_AGGREGATOR_AUDIT_TOKEN,
        durationMs: integer('duration-seconds', 1, 86400) * 1000,
        drainMs: integer('drain-seconds', 0, 3600) * 1000,
        intervalMs: integer('interval-ms', 100, 60000),
        timeoutMs: integer('timeout-ms', 100, 60000),
        maxPages: integer('max-pages', 1, 10000),
        maxRecordBytes: Number(process.env.BNPB_AGGREGATOR_SENSOR_PANTAI_MAX_RECORD_BYTES ?? 8192),
        maxFutureMs: Number(process.env.BNPB_AGGREGATOR_SENSOR_PANTAI_MAX_FUTURE_MS ?? 30000),
        maxSourceLagMs: Number(process.env.BNPB_AGGREGATOR_SENSOR_PANTAI_MAX_SOURCE_LAG_MS ?? 120000),
    };
    if (!options.sensorToken || !options.auditToken)
        throw new Error('Set PANTAI_AUTH_TOKEN and BNPB_AGGREGATOR_AUDIT_TOKEN, or create root .env');
    for (const key of ['maxRecordBytes', 'maxFutureMs', 'maxSourceLagMs']) {
        if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'maxRecordBytes' ? 1 : 0))
            throw new Error(`Invalid ${key}`);
    }
    for (const key of ['sensorUrl', 'auditUrl', 'notificationUrl']) {
        const url = new URL(options[key]);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error(`Invalid ${key}`);
    }
    let stop = false;
    const stopCollection = () => {
        stop = true;
    };
    process.once('SIGINT', stopCollection);
    let result;
    console.log(
        'Baselining historical data, then collecting new critical events. Ctrl+C ends collection and drains pending notifications.'
    );
    try {
        result = await runMeasurement(options, { shouldStop: () => stop });
    } catch (error) {
        result = {
            status: 'inconclusive',
            reason: `Baseline failed: ${error.message}`,
        };
    } finally {
        process.removeListener('SIGINT', stopCollection);
    }
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(
        JSON.stringify(
            {
                status: result.status,
                criticalExpected: result.criticalExpected,
                delivered: result.delivered,
                missingAfterDrain: result.missingAfterDrain,
                p95Ms: result.p95Ms,
                errorBudget: result.errorBudget,
                issues: result.issues ?? [result.reason],
                lastEndpointReadHealthy: result.lastEndpointReadHealthy,
                observerErrors: result.observerErrors,
                output,
            },
            null,
            2
        )
    );
    process.exitCode = result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => {
        console.error('Invalid measurement configuration or output path. Run with --help.');
        process.exitCode = 2;
    });
}
