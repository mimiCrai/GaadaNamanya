// Jest setup file
import 'reflect-metadata';
import { PVMBG_TOKEN, ROTATED_PVMBG_TOKEN } from './helpers';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.PVMBG_CLIENT_TOKENS ??= `${PVMBG_TOKEN},${ROTATED_PVMBG_TOKEN}`;
process.env.PVMBG_DELAY_MIN_MS ??= '0';
process.env.PVMBG_DELAY_MAX_MS ??= '0';
process.env.PVMBG_REPORT_INTERVAL_MS ??= '0';

// Increase timeout for integration tests
jest.setTimeout(10000);
