import { Logger } from 'pino';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createLogger } from '../src/libs/logger';

export const BMKG_KEY = 'bmkg_test01_0123456789abcdef0123456789abcdef';
export const ROTATED_BMKG_KEY = 'bmkg_test02_fedcba9876543210fedcba9876543210';
export const PVMBG_TOKEN = 'pvmbg.bnpb.4f9c2a7e1b3d5f60718293a4b5c6d7e8';
export const BNPB_JWT =
    'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkb3duc3RyZWFtLWNsaWVudCIsInNjb3BlIjoiaGF6YXJkOnJlYWQifQ.c2lnbmF0dXJl';

/** Builds the full app from the test env set in tests/setup.ts. */
export function buildApp(logger: Logger = createLogger({ level: 'silent' })) {
    return createApp(loadConfig(), { logger });
}
