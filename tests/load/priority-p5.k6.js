import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';

const base = (__ENV.CLIENT_API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const roles = {
    media: { token: __ENV.MEDIA_TOKEN, vus: Number(__ENV.MEDIA_VUS || 20) },
    field: { token: __ENV.FIELD_TOKEN, vus: Number(__ENV.FIELD_VUS || 5) },
};

for (const [name, role] of Object.entries(roles)) {
    if (!role.token) throw new Error(`Set the access token for ${name}`);
    if (!Number.isInteger(role.vus) || role.vus < 1) throw new Error(`Set a positive VU count for ${name}`);
    role.ok = new Counter(`${name}_http_200`);
    role.busy = new Counter(`${name}_http_503_retry_after`);
    role.other = new Counter(`${name}_other_status`);
    role.latency = new Trend(`${name}_successful_latency_ms`, true);
}

export const options = {
    summaryTrendStats: ['count', 'p(95)'],
    scenarios: Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, {
        executor: 'constant-vus', vus: role.vus, duration: '20s', gracefulStop: '5s',
    }])),
};

export default function () {
    const role = roles[exec.scenario.name];
    const result = http.get(`${base}/hazards?source=BMKG`, {
        headers: { Authorization: `Bearer ${role.token}` },
        timeout: '5s',
        responseCallback: http.expectedStatuses(200, 503),
    });
    const ok = result.status === 200;
    const busy = result.status === 503 && Boolean(result.headers['Retry-After']);
    role.ok.add(Number(ok));
    role.busy.add(Number(busy));
    role.other.add(Number(!ok && !busy));
    if (ok) role.latency.add(result.timings.duration);
}
