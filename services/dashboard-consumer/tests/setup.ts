// Jest setup file
import 'reflect-metadata';

process.env.DATABASE_URL ??= 'postgresql://postgres:password@localhost:5434/dashboard_test';
process.env.KAFKA_BROKERS ??= 'localhost:9092';

// Increase timeout for integration tests
jest.setTimeout(10000);
