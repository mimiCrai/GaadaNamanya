/** @type {import('jest').Config} */
const config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    coverageDirectory: 'coverage',
    verbose: true,
};

module.exports = config;
