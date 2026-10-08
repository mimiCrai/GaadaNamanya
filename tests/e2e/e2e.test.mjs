import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const config = {
    bmkgUrl: required('BMKG_URL'),
    pvmbgUrl: required('PVMBG_URL'),
    aggregatorUrl: required('AGGREGATOR_URL'),
    dashboardUrl: required('DASHBOARD_URL'),
    notificationUrl: required('NOTIFICATION_URL'),
    authUrl: required('AUTH_URL'),
    clientApiUrl: required('CLIENT_API_URL'),
    bmkgApiKey: required('BMKG_API_KEY'),
    pvmbgToken: required('PVMBG_TOKEN'),
    internalApiKey: required('BNPB_INTERNAL_API_KEY'),
};

const internalHeaders = { 'X-BNPB-Internal-Key': config.internalApiKey };
const pvmbgHeaders = { Authorization: `Bearer ${config.pvmbgToken}`, 'Content-Type': 'application/json' };

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} must be configured for the E2E runner`);
    return value;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
    const body = await response.json().catch(() => undefined);
    return { response, body };
}

async function createJson(url, body, headers = {}) {
    return fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

async function waitFor(description, predicate, timeoutMs = 75_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
        try {
            const result = await predicate();
            if (result !== undefined && result !== false) return result;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`${description} did not complete within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function getHazards(since) {
    const url = new URL('/internal/hazards', config.aggregatorUrl);
    if (since) url.searchParams.set('since', since);
    const { response, body } = await fetchJson(url, { headers: internalHeaders });
    assert.equal(response.status, 200, `Aggregator response: ${JSON.stringify(body)}`);
    return body;
}

async function setPvmbgOutage(enabled, mode = 'error') {
    const { response, body } = await fetchJson(`${config.pvmbgUrl}/admin/outage`, {
        method: 'POST',
        headers: pvmbgHeaders,
        body: JSON.stringify({ enabled, mode }),
    });
    assert.equal(response.status, 200, `PVMBG outage response: ${JSON.stringify(body)}`);
}

async function assertBmkgContinuesAfter(timestamp) {
    await waitFor('a newly ingested BMKG hazard during the PVMBG outage', async () => {
        const payload = await getHazards(timestamp);
        return payload.data.some((hazard) => hazard.source === 'BMKG');
    });
}

after(async () => {
    // A failed assertion must not leave the process in simulated outage mode.
    await setPvmbgOutage(false).catch(() => undefined);
});

test('BNPB polling, canonicalisation, and Kafka consumer flow', { timeout: 180_000 }, async (t) => {
    let accessToken;
    let refreshToken;

    await t.test('publishes an RSA public key and registers a public client user', async () => {
        await waitFor('bnpb-auth public key endpoint', async () => {
            const publicKey = await fetch(`${config.authUrl}/public-key`);
            return publicKey.status === 200 && /-----BEGIN PUBLIC KEY-----/.test(await publicKey.text());
        });

        const registered = await waitFor('bnpb-auth registration', async () => {
            const result = await createJson(`${config.authUrl}/auth/register`, {
                email: `e2e-${Date.now()}@example.test`,
                password: 'correct horse battery staple',
            });
            return result.response.status === 201 ? result : undefined;
        });
        assert.equal(registered.body.data.user.role, 'public');
        assert.equal(registered.body.data.accessToken.split('.').length, 3);
        accessToken = registered.body.data.accessToken;
        refreshToken = registered.body.data.refreshToken;
    });

    await t.test('rejects unauthenticated access to the Aggregator internal API', async () => {
        const { response } = await fetchJson(`${config.aggregatorUrl}/internal/hazards`);
        assert.equal(response.status, 401);
    });

    await t.test('ingests both providers and reports healthy source streams', async () => {
        await waitFor('initial canonical ingestion', async () => {
            const payload = await getHazards();
            const sources = new Set(payload.data.map((hazard) => hazard.source));
            const statuses = payload.meta?.pollingStatus ?? {};
            const allHealthy = ['BMKG_SEISMIC', 'BMKG_TSUNAMI_WARNING', 'PVMBG_VOLCANIC'].every(
                (stream) => statuses[stream]?.status === 'HEALTHY'
            );
            return sources.has('BMKG') && sources.has('PVMBG') && allHealthy ? payload : undefined;
        });
    });

    await t.test('authorises the client API and exposes only public hazard summaries', async () => {
        const unauthenticated = await fetchJson(`${config.clientApiUrl}/hazards`);
        assert.equal(unauthenticated.response.status, 401);

        const clientResult = await waitFor('bnpb-client-api authorised hazard response', async () => {
            const result = await fetchJson(`${config.clientApiUrl}/hazards`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            return result.response.status === 200 ? result : undefined;
        });
        const { body } = clientResult;
        assert.ok(body.data.length > 0);
        assert.ok(body.data.every((hazard) => hazard.Klasifikasi === 'ringkasan'));
        assert.ok(body.data.every((hazard) => !hazard.Keterangan.includes('sourceRefId')));

        const canonical = await getHazards();
        const hazardId = canonical.data[0].hazardId;
        const byId = await fetchJson(`${config.clientApiUrl}/hazards/${hazardId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        assert.equal(byId.response.status, 200, `Client API by-id response: ${JSON.stringify(byId.body)}`);
        assert.equal(byId.body.data.Klasifikasi, 'ringkasan');

        const invalidToken = `${accessToken.slice(0, -1)}${accessToken.endsWith('a') ? 'b' : 'a'}`;
        const rejected = await fetchJson(`${config.clientApiUrl}/hazards`, {
            headers: { Authorization: `Bearer ${invalidToken}` },
        });
        assert.equal(rejected.response.status, 401);
    });

    await t.test('rotates and revokes the Auth refresh session', async () => {
        const refreshed = await createJson(`${config.authUrl}/auth/refresh`, { refreshToken });
        assert.equal(refreshed.response.status, 200, `Auth refresh response: ${JSON.stringify(refreshed.body)}`);
        assert.notEqual(refreshed.body.data.refreshToken, refreshToken);
        refreshToken = refreshed.body.data.refreshToken;

        const loggedOut = await createJson(`${config.authUrl}/auth/logout`, { refreshToken });
        assert.equal(loggedOut.response.status, 204);

        const revoked = await createJson(`${config.authUrl}/auth/refresh`, { refreshToken });
        assert.equal(revoked.response.status, 401);
    });

    await t.test('rejects credentials from the other provider', async () => {
        const bmkg = await fetchJson(`${config.bmkgUrl}/seismic-events`, {
            headers: { Authorization: `Bearer ${config.pvmbgToken}` },
        });
        assert.equal(bmkg.response.status, 403);

        const pvmbg = await fetchJson(`${config.pvmbgUrl}/volcanic-reports`, {
            headers: { 'X-BMKG-Key': config.bmkgApiKey },
        });
        assert.equal(pvmbg.response.status, 403);
    });

    await t.test('keeps PVMBG additive schema fields in canonical attributes', async () => {
        const marker = new Date().toISOString();
        const { response, body } = await fetchJson(`${config.pvmbgUrl}/admin/schema-version`, {
            method: 'POST',
            headers: pvmbgHeaders,
            body: JSON.stringify({ version: 2 }),
        });
        assert.equal(response.status, 200, JSON.stringify(body));

        await waitFor('a version 2 PVMBG hazard', async () => {
            const payload = await getHazards(marker);
            return payload.data.find(
                (hazard) => hazard.source === 'PVMBG' && typeof hazard.attributes?.confidence_level === 'number'
            );
        });
    });

    await t.test('projects canonical data to Dashboard and applies notification policy', async () => {
        await waitFor('the dashboard projection for the version 2 hazard', async () => {
            const { response, body } = await fetchJson(`${config.dashboardUrl}/api/hazards`);
            assert.equal(response.status, 200);
            const canonical = await getHazards();
            const v2Hazard = canonical.data.find(
                (hazard) => hazard.source === 'PVMBG' && typeof hazard.attributes?.confidence_level === 'number'
            );
            const projected = body.data.find((hazard) => hazard.hazardId === v2Hazard?.hazardId);
            return projected?.attributes?.confidence_level === v2Hazard?.attributes?.confidence_level;
        });

        await waitFor('at least one notification', async () => {
            const { response, body } = await fetchJson(`${config.notificationUrl}/api/notifications`);
            assert.equal(response.status, 200);
            assert.ok(body.data.every((notification) => ['SIAGA', 'AWAS'].includes(notification.severity)));
            return body.data.length > 0;
        });
    });

    await t.test('marks only PVMBG stale during an error outage and recovers', async () => {
        const marker = new Date().toISOString();
        await setPvmbgOutage(true, 'error');

        await waitFor('PVMBG stale while BMKG remains healthy', async () => {
            const payload = await getHazards();
            const status = payload.meta.pollingStatus;
            return status.PVMBG_VOLCANIC?.status === 'STALE' && status.BMKG_SEISMIC?.status === 'HEALTHY';
        });
        await assertBmkgContinuesAfter(marker);

        await setPvmbgOutage(false);
        await waitFor('PVMBG recovery', async () => (await getHazards()).meta.pollingStatus.PVMBG_VOLCANIC?.status === 'HEALTHY');
    });

    await t.test('times out a hanging PVMBG request without stopping BMKG polling', async () => {
        const marker = new Date().toISOString();
        await setPvmbgOutage(true, 'hang');

        await waitFor('PVMBG stale after its request timeout', async () => {
            const payload = await getHazards();
            return payload.meta.pollingStatus.PVMBG_VOLCANIC?.status === 'STALE';
        });
        await assertBmkgContinuesAfter(marker);

        await setPvmbgOutage(false);
        await waitFor('PVMBG recovery after hang outage', async () =>
            (await getHazards()).meta.pollingStatus.PVMBG_VOLCANIC?.status === 'HEALTHY'
        );
    });
});
