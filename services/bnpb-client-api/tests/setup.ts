// Jest setup file
import 'reflect-metadata';

process.env.BNPB_INTERNAL_API_KEY ??= 'test-bnpb-internal-api-key-at-least-32-characters';

// Increase timeout for integration tests
jest.setTimeout(10000);
