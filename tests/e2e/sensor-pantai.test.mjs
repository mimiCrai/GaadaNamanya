import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const project = process.env.COMPOSE_PROJECT_NAME;
assert.equal(project, 'bnpb-sensor-e2e', 'Infrastructure actions are restricted to the isolated sensor test project');
const base = process.env.AGGREGATOR_URL;
const internal = { 'X-BNPB-Internal-Key': process.env.BNPB_INTERNAL_API_KEY };
const audit = { Authorization: `Bearer ${process.env.BNPB_AUDIT_TOKEN}` };
const sensorAuth = { Authorization: `Bearer ${process.env.SENSOR_TOKEN}` };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();

async function json(url, headers = {}) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    assert.equal(response.status, 200, `${new URL(url).pathname}: HTTP ${response.status}`);
    return response.json();
}
async function eventually(work, timeout = 60000) {
    const until = performance.now() + timeout;
    let lastError;
    while (performance.now() < until) {
        try { const result = await work(); if (result) return result; } catch (error) { lastError = error; }
        await delay(300);
    }
    throw lastError ?? new Error('Timed out waiting for Sensor Pantai integration');
}
const hazards = () => json(`${base}/internal/hazards`, internal);
const status = () => json(`${base}/internal/sensor-pantai/status`, audit);

test('Official Sensor Pantai: validation, notifications, isolation, and recovery', { timeout: 240000 }, async (t) => {
    let capturedCritical = [];
    await t.test('uses a separate sensor credential and protects quarantined data', async () => {
        const unauthenticated = await fetch(`${process.env.SENSOR_URL}/v1/stations`);
        assert.equal(unauthenticated.status, 401);
        const foreign = await fetch(`${process.env.SENSOR_URL}/v1/stations`, { headers: { Authorization: `Bearer ${process.env.BMKG_API_KEY}` } });
        assert.equal(foreign.status, 401);
        const rejected = await fetch(`${base}/internal/sensor-pantai/rejected`, { headers: internal });
        assert.equal(rejected.status, 401);
    });

    await t.test('ingests COASTAL observations and projects them to Dashboard', async () => {
        const canonical = await eventually(async () => {
            const body = await hazards();
            const coastal = body.data.filter((row) => row.source === 'SENSOR_PANTAI');
            return coastal.length > 0 ? coastal : null;
        });
        assert.ok(canonical.every((row) => row.hazardType === 'COASTAL'));
        assert.equal(new Set(canonical.map((row) => row.sourceRefId)).size, canonical.length);
        await eventually(async () => {
            const dashboard = await json(`${process.env.DASHBOARD_URL}/api/hazards`);
            return dashboard.data.some((row) => row.hazardId === canonical[0].hazardId);
        });
        const registration = await fetch(`${process.env.AUTH_URL}/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: `sensor-e2e-${Date.now()}@example.test`, password: 'SensorTestPassword123!' }),
        });
        assert.equal(registration.status, 201);
        const session = await registration.json();
        const visible = await json(`${process.env.CLIENT_API_URL}/hazards?source=SENSOR_PANTAI`, { Authorization: `Bearer ${session.data.accessToken}` });
        assert.ok(visible.data.length > 0);
        assert.ok(visible.data.every((row) => row.Tipe === 'COASTAL'));
        assert.deepEqual(Object.keys(visible.meta.sources), ['SENSOR_PANTAI']);
    });

    await t.test('delivers every valid critical observation in the source snapshot to the notification inbox', async () => {
        capturedCritical = await eventually(async () => {
            const stations = await json(`${process.env.SENSOR_URL}/v1/stations`, sensorAuth);
            const stationIds = new Set(stations.items.map((station) => station.station_id));
            let cursor = null;
            const critical = [];
            for (let page = 0; page < 10; page++) {
                const result = await json(`${process.env.SENSOR_URL}/v1/observations?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, sensorAuth);
                for (const item of result.items) {
                    if (item && item.critical === true && typeof item.observation_id === 'string' && item.observation_id.length > 0 && item.observation_id.length <= 255 && stationIds.has(item.station_id) &&
                        Number.isFinite(item.wave_height_m) && item.wave_height_m >= 0 && Number.isFinite(item.sea_level_anomaly_m) &&
                        typeof item.quality === 'string' && item.quality.length > 0 && item.quality.length <= 64 &&
                        Buffer.byteLength(JSON.stringify(item)) <= 8192 && typeof item.observed_at === 'string' &&
                        Number.isFinite(Date.parse(item.observed_at)) && Date.parse(item.observed_at) <= Date.parse(result.generated_at) + 30000) critical.push(item.observation_id);
                }
                if (!result.next_cursor || result.items.length === 0) break;
                cursor = result.next_cursor;
            }
            return critical.length > 0 ? [...new Set(critical)] : null;
        });
        const matching = await eventually(async () => {
            const canonical = (await hazards()).data.filter((row) => row.source === 'SENSOR_PANTAI');
            return capturedCritical.every((id) => canonical.some((row) => row.sourceRefId === id)) ? canonical : null;
        });
        const ids = matching.filter((row) => capturedCritical.includes(row.sourceRefId)).map((row) => row.hazardId);
        await eventually(async () => {
            const inbox = await json(`${process.env.NOTIFICATION_URL}/api/notifications`);
            return ids.every((id) => inbox.data.some((row) => row.hazardId === id));
        });
        t.diagnostic(`All ${ids.length} valid critical observations from the snapshot reached the notification inbox`);
    });

    await t.test('a hanging sensor opens its circuit while BMKG continues, then recovers automatically', async () => {
        const sensor = docker('ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=sensor-pantai');
        assert.ok(sensor && !sensor.includes('\n'));
        const before = (await hazards()).data.filter((row) => row.source === 'BMKG').length;
        docker('pause', sensor);
        try {
            await eventually(async () => {
                const state = (await status()).data;
                return state.status === 'STALE' && state.retryAt && state.consecutiveFailures >= 3;
            });
            await eventually(async () => {
                const body = await hazards();
                return body.meta.pollingStatus.BMKG_SEISMIC.status === 'HEALTHY' && body.data.filter((row) => row.source === 'BMKG').length > before;
            });
        } finally { docker('unpause', sensor); }
        await eventually(async () => (await status()).data.status === 'HEALTHY');
        const after = (await hazards()).data.filter((row) => row.source === 'SENSOR_PANTAI');
        assert.equal(after.length, new Set(after.map((row) => row.sourceRefId)).size);
    });
});
