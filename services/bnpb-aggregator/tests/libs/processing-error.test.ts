import { MongoNetworkError, MongoServerError, MongoServerSelectionError } from 'mongodb';
import { LeaseLostError } from '../../src/db/schema/background-leases';
import { classifyError, HttpStatusError, ProcessingError } from '../../src/libs/processing-error';

describe('classifyError', () => {
    it.each([
        ['timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
        ['timeout', Object.assign(new Error('aborted'), { name: 'AbortError' })],
        ['connection', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })],
        ['connection', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
        ['upstream_unavailable', new HttpStatusError('PVMBG', 503)],
        ['upstream_unavailable', new HttpStatusError('Aggregator', 500)],
        ['upstream_unavailable', new HttpStatusError('Aggregator', 429)],
        ['store_unavailable', new MongoNetworkError('connection closed')],
        ['store_unavailable', new MongoServerSelectionError('no primary', { type: 'Unknown' } as never)],
        ['store_unavailable', new MongoServerError({ message: 'not primary', code: 10107 })],
        ['store_unavailable', new MongoServerError({ message: 'host unreachable', code: 6 })],
    ])('treats %s as retryable', (category, error) => {
        const result = classifyError(error);
        expect(result.category).toBe(category);
        expect(result.retryable).toBe(true);
        expect(result.reason).toMatch(new RegExp(`^${category}: .+`));
    });

    it('treats a transient transaction error label as store_unavailable', () => {
        const error = new MongoServerError({ message: 'write conflict', code: 112 });
        error.addErrorLabel('TransientTransactionError');
        expect(classifyError(error).category).toBe('store_unavailable');
    });

    it.each([
        'malformed_json',
        'invalid_utf8',
        'nesting_too_deep',
        'payload_too_large',
        'schema_incompatible',
        'validation_failed',
    ] as const)('keeps %s as non-retryable (parked)', (category) => {
        const result = classifyError(new ProcessingError(category, 'detail'));
        expect(result.retryable).toBe(false);
        expect(result.reason).toBe(`${category}: detail`);
    });

    it('treats a downstream 4xx rejection as permanent', () => {
        const result = classifyError(new HttpStatusError('Aggregator', 422));
        expect(result.category).toBe('validation_failed');
        expect(result.retryable).toBe(false);
    });

    it('treats unknown errors as retryable "unexpected" so they eventually park via retry_exhausted', () => {
        const result = classifyError(new Error('boom'));
        expect(result.category).toBe('unexpected');
        expect(result.retryable).toBe(true);
        expect(classifyError('a string').category).toBe('unexpected');
    });

    it('refuses to classify lease loss, which is not a message failure', () => {
        expect(() => classifyError(new LeaseLostError())).toThrow();
    });
});
