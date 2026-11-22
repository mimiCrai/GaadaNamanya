import 'reflect-metadata';

process.env.NODE_ENV = 'test';
process.env.KAFKA_BROKERS ??= 'localhost:9092';
process.env.BNPB_INTERNAL_API_KEY ??= 'test-bnpb-internal-api-key-at-least-32-characters';

jest.setTimeout(10000);
