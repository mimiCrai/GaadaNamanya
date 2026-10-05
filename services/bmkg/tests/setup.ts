// Jest setup file
import 'reflect-metadata';
import { BMKG_KEY, ROTATED_BMKG_KEY } from './helpers';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.BMKG_API_KEYS ??= `${BMKG_KEY},${ROTATED_BMKG_KEY}`;
process.env.BMKG_DELAY_MIN_MS ??= '0';
process.env.BMKG_DELAY_MAX_MS ??= '0';
process.env.BMKG_EVENT_INTERVAL_MS ??= '0';

// Increase timeout for integration tests
jest.setTimeout(10000);
