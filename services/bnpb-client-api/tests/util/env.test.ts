describe('Admission environment', () => {
    const keys = [
        'ADMISSION_MAX_CONCURRENT_REQUESTS',
        'ADMISSION_RESERVED_LAPANGAN_REQUESTS',
        'ADMISSION_RETRY_AFTER_SECONDS',
    ];
    const original = keys.map((key) => process.env[key]);

    beforeEach(() => {
        process.env.ADMISSION_MAX_CONCURRENT_REQUESTS = '3';
        process.env.ADMISSION_RESERVED_LAPANGAN_REQUESTS = '1';
        process.env.ADMISSION_RETRY_AFTER_SECONDS = '2';
    });

    afterEach(() =>
        keys.forEach((key, index) => {
            if (original[index] === undefined) delete process.env[key];
            else process.env[key] = original[index];
        })
    );

    function loadEnv() {
        let result: unknown;
        jest.isolateModules(() => {
            result = require('../../src/util/env').default;
        });
        return result;
    }

    it('parses valid limits from environment strings', () => {
        expect(loadEnv()).toMatchObject({
            ADMISSION_MAX_CONCURRENT_REQUESTS: 3,
            ADMISSION_RESERVED_LAPANGAN_REQUESTS: 1,
            ADMISSION_RETRY_AFTER_SECONDS: 2,
        });
    });

    it.each(['3', '4'])('rejects a reserved allowance of %s that leaves no shared capacity', (reserved) => {
        process.env.ADMISSION_RESERVED_LAPANGAN_REQUESTS = reserved;
        expect(loadEnv).toThrow('Reserved Lapangan capacity must be less');
    });

    it.each(keys)('rejects a zero value for %s', (key) => {
        process.env[key] = '0';
        expect(loadEnv).toThrow();
    });
});
