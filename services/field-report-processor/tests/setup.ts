// Jest setup file
import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.KAFKA_BROKERS ??= 'localhost:9092';
process.env.BNPB_INTERNAL_API_KEY ??= 'test-bnpb-internal-api-key-at-least-32-characters';
process.env.FIELD_REPORT_BACKOFF_BASE_MS ??= '10';
process.env.FIELD_REPORT_BACKOFF_CAP_MS ??= '100';

// Increase timeout for integration tests
jest.setTimeout(10000);
