import http from 'k6/http';
import { check, sleep } from 'k6';
import execution from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const baseUrl = (__ENV.AGGREGATOR_URL || 'http://localhost:3003').replace(/\/$/, '');
const apiKey = __ENV.BNPB_INTERNAL_API_KEY;
const vus = Number(__ENV.VUS || 10000);
const durationSeconds = Number(__ENV.DURATION_SECONDS || 150);
const pauseSeconds = Number(__ENV.ITERATION_SLEEP_SECONDS || 0);
const strict = __ENV.STRICT === 'true';
const sampleEvery = Number(__ENV.BODY_SAMPLE_EVERY || 20);
const mode = __ENV.LOAD_MODE || 'sustained';
const path = __ENV.HAZARD_PATH || '/internal/hazards?limit=50';

if (!apiKey) throw new Error('BNPB_INTERNAL_API_KEY is required');
if (!Number.isInteger(vus) || vus < 1) throw new Error('VUS must be a positive integer');
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('DURATION_SECONDS must be positive');
if (!Number.isInteger(sampleEvery) || sampleEvery < 1) throw new Error('BODY_SAMPLE_EVERY must be positive');
if (!Number.isFinite(pauseSeconds) || pauseSeconds < 0) throw new Error('ITERATION_SLEEP_SECONDS cannot be negative');

const successfulReads = new Counter('successful_reads');
const controlledRejections = new Counter('controlled_rejections');
const unexpectedErrors = new Rate('unexpected_error_rate');
const successfulLatency = new Trend('successful_read_latency', true);
const invalidBodies = new Rate('invalid_body_rate');
const expectedStatuses = strict ? http.expectedStatuses(200) : http.expectedStatuses(200, 429);

export const options = {
    discardResponseBodies: true,
    summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
    systemTags: ['status', 'method', 'name', 'scenario', 'expected_response'],
    setupTimeout: '30s',
    scenarios: {
        aggregator_reads: {
            executor: 'constant-vus',
            vus,
            duration: `${durationSeconds}s`,
            gracefulStop: '10s',
        },
    },
    thresholds: {
        unexpected_error_rate: [strict ? 'rate==0' : 'rate<0.01'],
        invalid_body_rate: ['rate==0'],
        successful_reads: ['count>0'],
        ...(strict ? { controlled_rejections: ['count==0'] } : {}),
    },
};

function validBody(response) {
    try {
        const body = response.json();
        return Array.isArray(body.data) && body.data.length > 0 && body.meta?.partial === false;
    } catch {
        return false;
    }
}

export function setup() {
    const response = http.get(`${baseUrl}${path}`, {
        headers: { 'X-BNPB-Internal-Key': apiKey },
        responseType: 'text',
        timeout: '10s',
        tags: { name: 'preflight' },
    });
    if (response.status !== 200 || !validBody(response)) {
        throw new Error(`Preflight failed (HTTP ${response.status}): need nonempty, complete canonical data`);
    }
    console.log('P2_LOAD_STARTED');
}

export default function () {
    const sampled = execution.vu.iterationInScenario % sampleEvery === 0;
    const response = http.get(`${baseUrl}${path}`, {
        headers: { 'X-BNPB-Internal-Key': apiKey },
        responseType: sampled ? 'text' : 'none',
        responseCallback: expectedStatuses,
        timeout: __ENV.REQUEST_TIMEOUT || '10s',
        tags: { name: 'aggregator-hazards' },
    });
    const rejected = response.status === 429;
    controlledRejections.add(rejected ? 1 : 0);
    if (!rejected || strict) unexpectedErrors.add(response.status !== 200);
    check(response, { 'successful or controlled response': (result) => result.status === 200 || (!strict && rejected) });
    successfulReads.add(response.status === 200 ? 1 : 0);
    if (response.status === 200) {
        successfulLatency.add(response.timings.duration);
        if (sampled) invalidBodies.add(!validBody(response));
    }
    if (pauseSeconds > 0) sleep(pauseSeconds);
}

export function handleSummary(data) {
    const metric = (name) => data.metrics[name]?.values || {};
    const report = {
        mode,
        target: baseUrl,
        vus,
        durationSeconds,
        iterationSleepSeconds: pauseSeconds,
        bodySampleEvery: sampleEvery,
        requestTimeout: __ENV.REQUEST_TIMEOUT || '10s',
        meetsP2LoadSize: vus >= 10000 && durationSeconds >= 120,
        path,
        strict,
        passed: Object.values(data.metrics).every((item) =>
            Object.values(item.thresholds || {}).every((threshold) => threshold.ok)
        ),
        successfulReads: metric('successful_reads'),
        latencyMs: metric('successful_read_latency'),
        unexpectedErrorRate: metric('unexpected_error_rate'),
        controlledRejections: metric('controlled_rejections'),
        invalidBodyRate: metric('invalid_body_rate'),
        metrics: data.metrics,
    };
    return {
        [__ENV.SUMMARY_PATH || 'test-results/k6-aggregator-p2.json']: JSON.stringify(report, null, 2),
        stdout: JSON.stringify({ ...report, metrics: undefined }, null, 2) + '\n',
    };
}
