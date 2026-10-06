import 'reflect-metadata';
import { Application } from 'express';
import request from 'supertest';
import { buildApp, PVMBG_TOKEN, waitFor } from '../helpers';

describe('OutageMiddleware', () => {
    const setOutage = (app: Application, body: object) =>
        request(app).post('/admin/outage').set('Authorization', `Bearer ${PVMBG_TOKEN}`).send(body);
    const getReports = (app: Application) =>
        request(app).get('/volcanic-reports').set('Authorization', `Bearer ${PVMBG_TOKEN}`);

    it('answers the data endpoint and /health with 503 in error mode, then recovers', async () => {
        const { app } = await buildApp();
        await setOutage(app, { enabled: true, mode: 'error' });

        const data = await getReports(app);
        const health = await request(app).get('/health');

        expect(data.status).toBe(503);
        expect(data.body).toEqual(expect.objectContaining({ error: 'service_unavailable' }));
        expect(health.status).toBe(503);

        await setOutage(app, { enabled: false });
        expect((await getReports(app)).status).toBe(200);
        expect((await request(app).get('/health')).status).toBe(200);
    });

    it('checks the outage before auth, like a dead service', async () => {
        const { app } = await buildApp();
        await setOutage(app, { enabled: true });

        const response = await request(app).get('/volcanic-reports');

        expect(response.status).toBe(503);
    });

    it('never answers in hang mode and forgets a request once the client gives up', async () => {
        const { app, outage } = await buildApp();
        await setOutage(app, { enabled: true, mode: 'hang' });

        await expect(request(app).get('/health').timeout(150)).rejects.toThrow(/Timeout/);

        await waitFor(() => outage.heldCount === 0);
    });

    it('answers still-held requests with 503 when the outage is switched off', async () => {
        const { app, outage } = await buildApp();
        await setOutage(app, { enabled: true, mode: 'hang' });

        const pending = Promise.all([getReports(app), request(app).get('/health')]);
        await waitFor(() => outage.heldCount === 2);
        const ended = await setOutage(app, { enabled: false });

        const [data, health] = await pending;
        expect(ended.body).toEqual(expect.objectContaining({ enabled: false, released_requests: 2 }));
        expect(data.status).toBe(503);
        expect(health.status).toBe(503);
        expect(outage.heldCount).toBe(0);
    });

    it('releases held requests when switching from hang to error mode', async () => {
        const { app, outage } = await buildApp();
        await setOutage(app, { enabled: true, mode: 'hang' });

        const pending = getReports(app).then((response) => response); // supertest only sends once then() is called
        await waitFor(() => outage.heldCount === 1);
        await setOutage(app, { enabled: true, mode: 'error' });

        expect((await pending).status).toBe(503);
    });
});
