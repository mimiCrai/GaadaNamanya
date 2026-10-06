// Jest setup file
import 'reflect-metadata';
import { BMKG_KEY, closeTestDb, ROTATED_BMKG_KEY } from './helpers';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/bmkg_test';
process.env.BMKG_API_KEYS ??= `${BMKG_KEY},${ROTATED_BMKG_KEY}`;
process.env.BMKG_DELAY_MIN_MS ??= '0';
process.env.BMKG_DELAY_MAX_MS ??= '0';
process.env.BMKG_EVENT_INTERVAL_MS ??= '0';
process.env.BMKG_EVENT_GENERATION_PROBABILITY ??= '1';

jest.setTimeout(30000);

afterAll(() => closeTestDb());
