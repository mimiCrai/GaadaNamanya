import 'reflect-metadata';

process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/canonical_store_test';
process.env.KAFKA_BROKERS ??= 'localhost:9092';
process.env.BNPB_INTERNAL_API_KEY ??= 'test-bnpb-internal-key-0123456789';
process.env.BMKG_BASE_URL ??= 'http://localhost:8081';
process.env.BMKG_API_KEY ??= 'test-bmkg-api-key';
process.env.PVMBG_BASE_URL ??= 'http://localhost:8082';
process.env.PVMBG_TOKEN ??= 'test-pvmbg-token';
process.env.POLL_INTERVAL_MS ??= '3000';
process.env.POLL_OVERLAP_MS ??= '1000';
process.env.OUTBOX_RELAY_INTERVAL_MS ??= '250';
process.env.OUTBOX_BATCH_SIZE ??= '100';

jest.setTimeout(10000);
