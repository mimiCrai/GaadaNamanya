import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const project = process.env.COMPOSE_PROJECT_NAME ?? 'bnpb-failover';
const docker = (...args) =>
    execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const serviceIds = (service) =>
    docker(
        'ps',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        `label=com.docker.compose.service=${service}`,
        '--format',
        '{{.ID}}'
    )
        .split(/\r?\n/)
        .filter(Boolean);
const headers = { 'X-BNPB-Internal-Key': process.env.BNPB_INTERNAL_API_KEY };
let base;

async function get(path) {
    const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(8000) });
    assert.equal(response.status, 200, `${path} must remain available`);
    return response.json();
}

async function eventually(work, timeout = 60_000) {
    const start = performance.now();
    let last;
    while (performance.now() - start < timeout) {
        try {
            const value = await work();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        await delay(300);
    }
    throw last ?? new Error('Condition did not become true');
}

function containerFor(ownerId) {
    const hostname = ownerId.split(':')[0];
    return serviceIds('bnpb-aggregator').find((id) => docker('inspect', '-f', '{{.Config.Hostname}}', id) === hostname);
}

function upstreamCalls(since) {
    const [source] = serviceIds('bmkg');
    return docker('logs', '--since', since, source)
        .split(/\r?\n/)
        .flatMap((line) => {
            try {
                const row = JSON.parse(line);
                return row.path === '/seismic-events' && row.caller_instance_id ? [row] : [];
            } catch {
                return [];
            }
        });
}

test(
    'Three Aggregators: one poller owner, clock skew, freeze/resume, and crash failover',
    { timeout: 240_000 },
    async (t) => {
        base = process.env.AGGREGATOR_URL;
        let active;

        await t.test('three real instances serve reads while only one polls upstream', async () => {
            assert.equal(serviceIds('bnpb-aggregator').length, 3);
            const observed = new Set();
            for (let i = 0; i < 18; i++) observed.add((await get('/internal/leadership')).instanceId);
            assert.equal(observed.size, 3, 'The entry point must distribute reads across three instances');
            active = (await get('/internal/leadership')).lease;
            const since = new Date().toISOString();
            await delay(7000);
            const calls = upstreamCalls(since);
            assert.ok(calls.length >= 2, 'Use actual upstream request logs');
            assert.deepEqual([...new Set(calls.map((row) => row.caller_instance_id))], [active.ownerId]);
            assert.ok(calls.every((row) => Number(row.fencing_token) === active.epoch));
        });

        await t.test('clock changes +45s then -30s preserve the owner and epoch', async () => {
            const container = containerFor(active.ownerId);
            assert.ok(container);
            for (const signal of ['USR1', 'USR2']) {
                docker('kill', '--signal', signal, container);
                await delay(4500);
                const current = (await get('/internal/leadership')).lease;
                assert.equal(current.ownerId, active.ownerId);
                assert.equal(current.epoch, active.epoch);
                assert.ok(
                    Math.abs(Date.parse(current.checkedAt) - Date.now()) < 5000,
                    'Lease time must come from MongoDB'
                );
            }
        });

        await t.test(
            'freezing the leader elects a replacement within 60s; resumed old token cannot write',
            async () => {
                const old = active;
                const container = containerFor(old.ownerId);
                const since = new Date().toISOString();
                const start = performance.now();
                docker('pause', container);
                try {
                    active = await eventually(async () => {
                        const status = await get('/internal/leadership');
                        await get('/internal/hazards?limit=10');
                        return status.lease.ownerId !== old.ownerId && status.lease.epoch > old.epoch
                            ? status.lease
                            : null;
                    });
                    assert.ok(performance.now() - start < 60_000);
                    t.diagnostic(`Freeze takeover: ${Math.round(performance.now() - start)} ms`);
                    // Probe every fenced database mutation using the old epoch before its process resumes.
                    const healthy = containerFor(active.ownerId);
                    const script = `
                require('reflect-metadata');
                const {db}=require('./dist/src/db');
                const {BackgroundLeaseRepository}=require('./dist/src/repositories/background-lease.repository');
                const {HazardEventRepository}=require('./dist/src/repositories/hazard-event.repository');
                const {SourceSyncStateRepository}=require('./dist/src/repositories/source-sync-state.repository');
                const {PendingTsunamiWarningRepository}=require('./dist/src/repositories/pending-tsunami-warning.repository');
                const {OutboxEventRepository}=require('./dist/src/repositories/outbox-event.repository');
                (async()=>{await db.connect(); const leases=new BackgroundLeaseRepository(db); const old=${JSON.stringify({ ownerId: old.ownerId, epoch: old.epoch })};
                const actions=[
                    ()=>new HazardEventRepository(db,leases).upsertAndEnqueue({source:'BMKG',sourceRefId:'stale-owner-probe',lease:old}),
                    ()=>new SourceSyncStateRepository(db,leases).recordSuccessfulPoll('BMKG_SEISMIC',new Date(),old),
                    ()=>new SourceSyncStateRepository(db,leases).recordFailedPoll('BMKG_SEISMIC','old',new Date(),old),
                    ()=>new PendingTsunamiWarningRepository(db,leases).save({warning_id:'old-warning'},old),
                    ()=>new PendingTsunamiWarningRepository(db,leases).remove('old-warning',old),
                    ()=>new OutboxEventRepository(db,leases).markPublished('old-outbox',old),
                    ()=>new OutboxEventRepository(db,leases).recordPublishFailure('old-outbox','old',old)];
                for(const action of actions){try{await action();throw new Error('Stale mutation succeeded')}catch(e){if(e.constructor.name!=='LeaseLostError')throw e}}
                await db.close();console.log('All stale writes rejected')})().catch(e=>{console.error(e);process.exit(1)});`;
                    assert.match(docker('exec', healthy, 'node', '-e', script), /All stale writes rejected/);
                } finally {
                    docker('unpause', container);
                }
                await delay(7000);
                const current = (await get('/internal/leadership')).lease;
                assert.equal(current.ownerId, active.ownerId);
                assert.equal(current.epoch, active.epoch);
                const calls = upstreamCalls(since).filter((row) => Number(row.fencing_token) >= active.epoch);
                assert.ok(calls.length > 0);
                assert.ok(calls.every((row) => row.caller_instance_id === active.ownerId));
                const hazards = await get('/internal/hazards');
                assert.equal(new Set(hazards.data.map((row) => row.hazardId)).size, hazards.data.length);
                assert.equal(
                    hazards.data.some((row) => row.sourceRefId === 'stale-owner-probe'),
                    false
                );
            }
        );

        await t.test('a killed leader is replaced and ingestion continues without duplicate identities', async () => {
            const old = active;
            const before = await get('/internal/hazards');
            const since = new Date().toISOString();
            docker('kill', '--signal', 'KILL', containerFor(old.ownerId));
            const start = performance.now();
            active = await eventually(async () => {
                const { lease } = await get('/internal/leadership');
                return lease.ownerId !== old.ownerId && lease.epoch > old.epoch ? lease : null;
            });
            assert.ok(performance.now() - start < 60_000);
            t.diagnostic(`Crash takeover: ${Math.round(performance.now() - start)} ms`);
            const after = await eventually(async () => {
                const page = await get('/internal/hazards');
                return page.data.length > before.data.length ? page : null;
            });
            assert.equal(new Set(after.data.map((row) => `${row.source}:${row.sourceRefId}`)).size, after.data.length);
            const ids = new Set(after.data.map((row) => row.hazardId));
            assert.ok(before.data.every((row) => ids.has(row.hazardId)));

            const snapshots = await Promise.all(
                [
                    [
                        process.env.BMKG_URL,
                        '/seismic-events',
                        { 'X-BMKG-Key': process.env.BMKG_API_KEY },
                        'BMKG',
                        'event_id',
                    ],
                    [
                        process.env.PVMBG_URL,
                        '/volcanic-reports',
                        { Authorization: `Bearer ${process.env.PVMBG_TOKEN}` },
                        'PVMBG',
                        'report_id',
                    ],
                ].map(async ([url, path, auth, source, key]) => {
                    const response = await fetch(`${url}${path}?since=${encodeURIComponent(since)}`, {
                        headers: auth,
                        signal: AbortSignal.timeout(8000),
                    });
                    assert.equal(response.status, 200);
                    return (await response.json()).data.map((row) => `${source}:${row[key]}`);
                })
            );
            assert.ok(snapshots.every((rows) => rows.length > 0));
            const expected = snapshots.flat();
            const caughtUp = await eventually(async () => {
                const page = await get('/internal/hazards');
                const refs = new Set(page.data.map((row) => `${row.source}:${row.sourceRefId}`));
                return expected.every((ref) => refs.has(ref)) ? page : null;
            });
            const expectedIds = caughtUp.data
                .filter((row) => expected.includes(`${row.source}:${row.sourceRefId}`))
                .map((row) => row.hazardId);
            await eventually(async () => {
                const response = await fetch(`${process.env.DASHBOARD_URL}/api/hazards`, {
                    signal: AbortSignal.timeout(8000),
                });
                assert.equal(response.status, 200);
                const projected = new Set((await response.json()).data.map((row) => row.hazardId));
                return expectedIds.every((id) => projected.has(id));
            });
            t.diagnostic(
                `All ${expected.length} source records from the crash interval reached Canonical Store and Dashboard`
            );
        });
    }
);
