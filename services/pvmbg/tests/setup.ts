// Jest setup file
import 'reflect-metadata';
import { closeTestDb, PVMBG_TOKEN, ROTATED_PVMBG_TOKEN } from './helpers';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/pvmbg_test';
process.env.PVMBG_CLIENT_TOKENS ??= `${PVMBG_TOKEN},${ROTATED_PVMBG_TOKEN}`;
process.env.PVMBG_DELAY_MIN_MS ??= '0';
process.env.PVMBG_DELAY_MAX_MS ??= '0';
process.env.PVMBG_REPORT_INTERVAL_MS ??= '0';
process.env.PVMBG_REPORT_GENERATION_PROBABILITY ??= '1';

jest.setTimeout(30000);

afterAll(() => closeTestDb());
