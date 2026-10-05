import { AddressInfo } from 'net';
import { Writable } from 'stream';
import { Application } from 'express';
import { Logger } from 'pino';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { TYPES } from '../src/constants/types';
import { createLogger } from '../src/libs/logger';
import { IReportStore } from '../src/repositories/report.store';

export const PVMBG_TOKEN = 'pvmbg.bnpb.4f9c2a7e1b3d5f60718293a4b5c6d7e8';
export const ROTATED_PVMBG_TOKEN = 'pvmbg.bnpb-2.0123456789abcdef0123456789abcdef';
export const BMKG_KEY = 'bmkg_test01_0123456789abcdef0123456789abcdef';
export const BNPB_JWT =
    'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkb3duc3RyZWFtLWNsaWVudCIsInNjb3BlIjoiaGF6YXJkOnJlYWQifQ.c2lnbmF0dXJl';

export interface BuildOptions {
    logger?: Logger;
    env?: Record<string, string>;
}

export function buildApp({ logger = createLogger({ level: 'silent' }), env = {} }: BuildOptions = {}) {
    const pvmbg = createApp(loadConfig({ ...process.env, ...env }), { logger });
    return { ...pvmbg, store: pvmbg.container.get<IReportStore>(TYPES.IReportStore) };
}

export function captureLogs() {
    const lines: string[] = [];
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            lines.push(chunk.toString());
            callback();
        },
    });
    return {
        logger: createLogger({ level: 'info', stream }),
        raw: () => lines.join(''),
        entries: (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line)),
    };
}

export async function listen(app: Application) {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

export async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
