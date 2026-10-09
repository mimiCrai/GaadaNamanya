import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import execution from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { refreshSession, registerSessions, withoutTrailingSlash } from './lib/sessions.js';

const clientApiBaseUrl = withoutTrailingSlash(__ENV.CLIENT_API_BASE_URL || 'http://localhost:3000');
const authBaseUrl = withoutTrailingSlash(__ENV.AUTH_BASE_URL || 'http://localhost:3001');
const pvmbgBaseUrl = withoutTrailingSlash(__ENV.PVMBG_BASE_URL || 'http://localhost:8082');
const pvmbgToken = __ENV.PVMBG_TOKEN || '';
const vusPerScenario = Number(__ENV.VUS_PER_SCENARIO || 25);
const duration = __ENV.DURATION || '60s';
const iterationSleepSeconds = Number(__ENV.ITERATION_SLEEP_SECONDS || 0.5);
const minPvmbgDelayMs = Number(__ENV.MIN_PVMBG_DELAY_MS || 0);
const pvmbgDelayProbes = 3;

const bmkgOnlyLatency = new Trend('bmkg_only_hazard_latency', true);
const pvmbgLatency = new Trend('pvmbg_hazard_latency', true);
const pvmbgDirectLatency = new Trend('pvmbg_direct_latency', true);
const controlledRejections = new Counter('controlled_rejections');
const unexpectedErrorRate = new Rate('unexpected_error_rate');
let session;

const scenarios = {
    bmkg_only: { executor: 'constant-vus', exec: 'bmkgOnly', vus: vusPerScenario, duration },
    pvmbg: { executor: 'constant-vus', exec: 'pvmbg', vus: vusPerScenario, duration },
};
if (pvmbgToken) {
    scenarios.pvmbg_direct_probe = { executor: 'constant-vus', exec: 'pvmbgDirectProbe', vus: 1, duration };
}

export const options = {
    summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    scenarios,
    thresholds: {
        bmkg_only_hazard_latency: ['p(95)<300'],
        unexpected_error_rate: ['rate<0.01'],
    },
};

export function setup() {
    if (minPvmbgDelayMs > 0) {
        if (!pvmbgToken) fail('MIN_PVMBG_DELAY_MS requires PVMBG_TOKEN to measure the PVMBG delay');
        for (let attempt = 0; attempt < pvmbgDelayProbes; attempt += 1) {
            const probe = requestPvmbgDirect();
            if (probe.status !== 200 || probe.timings.duration < minPvmbgDelayMs) {
                fail(
                    `PVMBG must answer in >= ${minPvmbgDelayMs}ms for this test, got HTTP ${probe.status} after ` +
                        `${Math.round(probe.timings.duration)}ms. Set PVMBG_DELAY_MIN_MS and PVMBG_DELAY_MAX_MS to 3000.`
                );
            }
        }
    }

    const totalVus = Object.values(scenarios).reduce((sum, scenario) => sum + scenario.vus, 0);
    return { sessions: registerSessions(authBaseUrl, totalVus) };
}

export function bmkgOnly({ sessions }) {
    const response = readHazards(sessions, 'BMKG');
    bmkgOnlyLatency.add(response.timings.duration);
    check(response, {
        'BMKG-only returns only seismic hazards': (result) =>
            result.status !== 200 || result.json('data').every((hazard) => hazard.Tipe === 'SEISMIC'),
        'BMKG-only reports BMKG freshness': (result) => result.status !== 200 || result.json('meta.sources.BMKG.status') !== null,
    });
    sleep(iterationSleepSeconds);
}

export function pvmbg({ sessions }) {
    const response = readHazards(sessions, 'PVMBG');
    pvmbgLatency.add(response.timings.duration);
    check(response, {
        'PVMBG returns only volcanic hazards': (result) =>
            result.status !== 200 || result.json('data').every((hazard) => hazard.Tipe === 'VOLCANIC'),
        'PVMBG reports PVMBG freshness': (result) => result.status !== 200 || result.json('meta.sources.PVMBG.status') !== null,
    });
    sleep(iterationSleepSeconds);
}

export function pvmbgDirectProbe() {
    const response = requestPvmbgDirect();
    pvmbgDirectLatency.add(response.timings.duration);
    sleep(1);
}

function readHazards(sessions, source) {
    if (!session) session = sessions[execution.vu.idInTest - 1];

    let response = requestHazards(session.accessToken, source);
    if (response.status === 401) {
        session = refreshSession(authBaseUrl, session.refreshToken);
        response = requestHazards(session.accessToken, source);
    }

    const controlledRejection = response.status === 429;
    controlledRejections.add(controlledRejection ? 1 : 0);
    unexpectedErrorRate.add(response.status !== 200 && !controlledRejection);
    check(response, {
        'hazards returns 200 or controlled 429': (result) => result.status === 200 || result.status === 429,
    });
    return response;
}

function requestHazards(accessToken, source) {
    return http.get(`${clientApiBaseUrl}/hazards?source=${source}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        tags: { endpoint: 'hazards', source },
        responseCallback: http.expectedStatuses(200, 401, 429),
    });
}

function requestPvmbgDirect() {
    return http.get(`${pvmbgBaseUrl}/volcanic-reports?limit=1`, {
        headers: { Authorization: `Bearer ${pvmbgToken}` },
        tags: { endpoint: 'pvmbg-direct' },
    });
}
