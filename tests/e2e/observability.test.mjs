import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';

const prometheus = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const tempo = process.env.TEMPO_URL ?? 'http://localhost:3200';
const grafana = process.env.GRAFANA_URL ?? 'http://localhost:3006';
const auth = process.env.AUTH_URL ?? 'http://localhost:3001';
const client = process.env.CLIENT_API_URL ?? 'http://localhost:3000';

async function json(url, options = {}) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);
    return response.json();
}

async function waitFor(description, work, timeout = 120_000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        try {
            const result = await work();
            if (result) return result;
        } catch (error) { last = error; }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`${description}: ${last?.message ?? 'timed out'}`);
}

async function query(expression) {
    const body = await json(`${prometheus}/api/v1/query?query=${encodeURIComponent(expression)}`);
    assert.equal(body.status, 'success');
    return body.data.result;
}

function servicesIn(trace) {
    const batches = trace.batches ?? trace.resourceSpans ?? [];
    return new Set(batches.map(batch => batch.resource?.attributes?.find(attr => attr.key === 'service.name')?.value?.stringValue).filter(Boolean));
}

test('observability: real HTTP, durable outbox, Kafka, metrics and provisioned dashboard', { timeout: 300_000 }, async t => {
    const evidence = {};
    await t.test('scrapes all seven services and every Aggregator replica', async () => {
        const targets = await waitFor('nine healthy application targets', async () => {
            const body = await json(`${prometheus}/api/v1/targets`);
            const apps = body.data.activeTargets.filter(target => ['applications', 'bnpb-aggregator'].includes(target.labels.job));
            return apps.length === 9 && apps.every(target => target.health === 'up') ? apps : undefined;
        });
        assert.equal(targets.filter(target => target.labels.job === 'bnpb-aggregator').length, 3);
        evidence.targets = targets.map(target => ({ address: target.scrapeUrl, health: target.health }));
        const leaders = await waitFor('one observed leader', async () => {
            const rows = await query('sum(bnpb_aggregator_leader)');
            return rows[0]?.value[1] === '1' ? rows : undefined;
        });
        assert.equal(leaders[0].value[1], '1');
        const errors = await query('max(bnpb_aggregator_metrics_read_error)');
        assert.equal(errors[0]?.value[1], '0');
    });

    await t.test('provisions Grafana datasources and the BNPB dashboard', async () => {
        const credentials = Buffer.from(`${process.env.GRAFANA_ADMIN_USER ?? 'admin'}:${process.env.GRAFANA_ADMIN_PASSWORD ?? 'local-grafana-password'}`).toString('base64');
        const options = { headers: { Authorization: `Basic ${credentials}` } };
        const dashboard = await waitFor('provisioned Grafana dashboard', () => json(`${grafana}/api/dashboards/uid/bnpb-overview`, options));
        assert.ok(dashboard.dashboard.panels.length >= 16);
        const sources = await json(`${grafana}/api/datasources`, options);
        assert.ok(sources.some(source => source.uid === 'prometheus'));
        assert.ok(sources.some(source => source.uid === 'tempo'));
        for (const panel of dashboard.dashboard.panels) {
            for (const target of panel.targets ?? []) if (target.expr) await query(target.expr);
        }
    });

    await t.test('preserves a trace through Client API, Auth and Aggregator HTTP calls', async () => {
        const registered = await waitFor('Auth registration', () => json(`${auth}/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: `observability-${randomUUID()}@example.test`, password: 'observability test password' }),
        }));
        const traceId = randomBytes(16).toString('hex');
        const correlationId = randomUUID();
        await json(`${client}/hazards`, { headers: {
            Authorization: `Bearer ${registered.data.accessToken}`,
            'X-Correlation-ID': correlationId,
            traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01`,
        } });
        const chain = await waitFor('HTTP trace across three services', async () => {
            const body = await json(`${tempo}/api/traces/${traceId}`);
            const names = servicesIn(body);
            return ['bnpb-client-api', 'bnpb-auth', 'bnpb-aggregator'].every(name => names.has(name)) ? body : undefined;
        });
        assert.ok(JSON.stringify(chain).includes(correlationId));
        assert.ok(!JSON.stringify(chain).includes(registered.data.accessToken));
        evidence.httpTraceId = traceId;
        evidence.httpServices = [...servicesIn(chain)];
        await waitFor('role metrics', async () => (await query('sum(bnpb_http_requests_total{service="bnpb-client-api",role="public",status_code="200"})'))[0]?.value[1] > 0);
    });

    await t.test('restores an ingestion trace after Mongo outbox persistence and both independent Kafka groups', async () => {
        const chain = await waitFor('poll-source to both consumer trace', async () => {
            const q = encodeURIComponent('{ resource.service.name = "bnpb-aggregator" && name = "source.poll" }');
            const search = await json(`${tempo}/api/search?q=${q}&limit=30`);
            for (const candidate of search.traces ?? []) {
                const body = await json(`${tempo}/api/traces/${candidate.traceID}`);
                const names = servicesIn(body);
                if ((names.has('bmkg') || names.has('pvmbg')) && names.has('dashboard-consumer') && names.has('notification-consumer')) {
                    return { id: candidate.traceID, body };
                }
            }
        });
        const serialized = JSON.stringify(chain.body);
        assert.ok(serialized.includes('kafka.publish'));
        assert.ok(serialized.includes('kafka.process'));
        evidence.ingestionTraceId = chain.id;
        evidence.ingestionServices = [...servicesIn(chain.body)];
        const metrics = await query('sum by(service) (bnpb_consumer_messages_total{outcome="processed"})');
        assert.equal(metrics.length, 2);
        assert.ok(metrics.every(row => Number(row.value[1]) > 0));
    });
    await writeFile('/results/summary.json', JSON.stringify(evidence, null, 2) + '\n');
});
