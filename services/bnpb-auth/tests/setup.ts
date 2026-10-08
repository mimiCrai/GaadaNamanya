// Jest setup file
import 'reflect-metadata';
import { generateKeyPairSync } from 'crypto';

process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/app';
process.env.JWT_PRIVATE_KEY ??= generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString();

// Increase timeout for integration tests
jest.setTimeout(10000);
