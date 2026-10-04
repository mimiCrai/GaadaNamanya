// Jest setup file
import 'reflect-metadata';

// The controller tests mock database-backed services, but importing those
// services still validates the application's configuration.
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/canonical_store_test';
process.env.KAFKA_BROKERS ??= 'localhost:9092';

// Increase timeout for integration tests
jest.setTimeout(10000);
