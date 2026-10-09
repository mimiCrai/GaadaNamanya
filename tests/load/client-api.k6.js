import http from 'k6/http';
import { check, sleep } from 'k6';
import execution from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { refreshSession, registerSessions, withoutTrailingSlash } from './lib/sessions.js';

const clientApiBaseUrl = withoutTrailingSlash(__ENV.CLIENT_API_BASE_URL || 'http://localhost:3000');
const authBaseUrl = withoutTrailingSlash(__ENV.AUTH_BASE_URL || 'http://localhost:3001');
const vus = Number(__ENV.VUS || 50);
const duration = __ENV.DURATION || '60s';
const iterationSleepSeconds = Number(__ENV.ITERATION_SLEEP_SECONDS || 1);

const hazardLatency = new Trend('client_api_hazard_latency', true);
const controlledRejections = new Counter('controlled_rejections');
const unexpectedErrorRate = new Rate('unexpected_error_rate');
let session;

export const options = {
    summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    scenarios: {
        sustained_hazard_reads: {
            executor: 'constant-vus',
            vus,
            duration,
        },
    },
    thresholds: {
        unexpected_error_rate: ['rate<0.01'],
    },
};

export function setup() {
    return { sessions: registerSessions(authBaseUrl, vus) };
}

export default function ({ sessions }) {
    if (!session) session = sessions[execution.vu.idInTest - 1];

    let response = requestHazards(session.accessToken);
    if (response.status === 401) {
        session = refreshSession(authBaseUrl, session.refreshToken);
        response = requestHazards(session.accessToken);
    }

    const controlledRejection = response.status === 429;
    controlledRejections.add(controlledRejection ? 1 : 0);
    unexpectedErrorRate.add(response.status !== 200 && !controlledRejection);
    hazardLatency.add(response.timings.duration);

    check(response, {
        'hazards returns 200 or controlled 429': (result) => result.status === 200 || result.status === 429,
        'successful hazards response has data': (result) => result.status === 429 || Array.isArray(result.json('data')),
    });

    sleep(iterationSleepSeconds);
}

function requestHazards(accessToken) {
    return http.get(`${clientApiBaseUrl}/hazards`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        tags: { endpoint: 'hazards' },
        responseCallback: http.expectedStatuses(200, 401, 429),
    });
}
