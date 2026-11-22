import http from 'k6/http';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';

const api = (__ENV.CLIENT_API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const auth = (__ENV.AUTH_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const latency = { BMKG: new Trend('bmkg_hazard_latency', true), PVMBG: new Trend('pvmbg_hazard_latency', true) };
const errors = { BMKG: new Rate('bmkg_error_rate'), PVMBG: new Rate('pvmbg_error_rate') };
let accessToken;

export const options = {
    summaryTrendStats: ['count', 'p(95)', 'p(99)'],
    scenarios: Object.fromEntries(Object.keys(latency).map((source) => [source, {
        executor: 'constant-vus', vus: Number(__ENV.VUS_PER_SOURCE || 25), duration: __ENV.DURATION || '60s',
    }])),
};

function login() {
    const response = http.post(`${auth}/auth/login`, JSON.stringify({
        email: __ENV.MEDIA_EMAIL || 'public@example.test', password: __ENV.MEDIA_PASSWORD,
    }), { headers: { 'Content-Type': 'application/json' }, timeout: '5s' });
    return response.status === 200 ? response.json('data.accessToken') : null;
}

export function setup() {
    if (!__ENV.MEDIA_PASSWORD) throw new Error('Set MEDIA_PASSWORD for the seeded Media account');
    const token = login();
    if (!token) throw new Error('Could not log in with the seeded Media account');
    return { accessToken: token };
}

export default function (setupData) {
    const source = exec.scenario.name;
    const startedAt = Date.now();
    const read = () => http.get(`${api}/hazards?source=${source}`, {
        headers: { Authorization: `Bearer ${accessToken}` }, timeout: '5s',
    });
    accessToken ??= setupData.accessToken;
    let response = read();
    if (response.status === 401) {
        accessToken = login();
        if (!accessToken) {
            errors[source].add(true);
            return;
        }
        response = read();
    }
    const ok = response.status === 200;
    errors[source].add(!ok);
    if (ok) latency[source].add(Date.now() - startedAt);
}
