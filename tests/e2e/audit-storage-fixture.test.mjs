import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Run the actual E2E assertions with a deterministic response and no live services.
const preload = `
globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname !== '/internal/analytics') throw new Error('Unexpected fixture request: ' + url);
    const invalid = url.searchParams.has('from') && url.searchParams.get('from') >= url.searchParams.get('to');
    return new Response(invalid ? '{}' : process.env.ANALYTICS_FIXTURE_BODY, { status: invalid ? 400 : 200 });
};
`;

function runFixture(body, stage = 'normal') {
    const env = {
        ...process.env,
        AGGREGATOR_URL: 'http://fixture.invalid',
        DASHBOARD_URL: '',
        STORAGE_TEST_STAGE: stage,
        ANALYTICS_FIXTURE_BODY: JSON.stringify(body),
    };
    // Start an independent runner instead of inheriting the parent's test IPC context.
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [
        '--import', 'data:text/javascript,' + encodeURIComponent(preload),
        '--test', '--test-name-pattern=^Canonical analytics coverage:',
        fileURLToPath(new URL('./audit-storage.test.mjs', import.meta.url)),
    ], {
        encoding: 'utf8', timeout: 10_000,
        env,
    });
}

const fixture = () => ({
    total: 6,
    byType: { SEISMIC: 5, VOLCANIC: 0, WILDFIRE: 0, COASTAL: 1, TSUNAMI: 2 },
    byArea: { Aceh: 6 },
    bySeverity: { SIAGA: 6 },
    byDay: {
        '2026-01-01': { SEISMIC: 2, TSUNAMI: 1 },
        '2026-01-02': { SEISMIC: 3, COASTAL: 1, TSUNAMI: 1 },
    },
    partial: false,
    degraded: false,
    unavailable_units: [],
});

for (const stage of ['normal', 'outage', 'recovery']) {
    test(`analytics assertions accept six unique hazards and two overlapping warnings: ${stage}`, () => {
        const body = fixture();
        if (stage === 'outage') {
            body.partial = true;
            body.degraded = true;
            body.unavailable_units = ['canonical-shard-b'];
        }
        const result = runFixture(body, stage);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });
}

test('analytics assertions accept no tsunami warnings', () => {
    const body = fixture();
    body.byType.TSUNAMI = 0;
    for (const day of Object.values(body.byDay)) delete day.TSUNAMI;
    const result = runFixture(body);
    assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const error of ['canonical total', 'tsunami total', 'daily total', 'daily distribution']) {
    test(`analytics assertions reject an incorrect ${error}`, () => {
        const body = fixture();
        if (error === 'canonical total') body.total = 8;
        if (error === 'tsunami total') body.byType.TSUNAMI = 6;
        if (error === 'daily total') body.byDay['2026-01-01'].TSUNAMI = 0;
        if (error === 'daily distribution') {
            body.byDay['2026-01-01'].TSUNAMI = 3;
            body.byDay['2026-01-02'].TSUNAMI = -1;
        }
        const result = runFixture(body);
        assert.equal(result.status, 1, result.stdout + result.stderr);
    });
}
