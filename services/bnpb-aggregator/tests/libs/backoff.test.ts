import { computeBackoffMs } from '../../src/libs/backoff';
import { ProcessingError } from '../../src/libs/processing-error';
import { decideFailureOutcome } from '../../src/services/unprocessed-retry.service';

describe('computeBackoffMs', () => {
    it('doubles per attempt with equal jitter between 50% and 100%', () => {
        expect(computeBackoffMs(1, 1000, 60_000, () => 0)).toBe(500);
        expect(computeBackoffMs(1, 1000, 60_000, () => 1)).toBe(1000);
        expect(computeBackoffMs(3, 1000, 60_000, () => 1)).toBe(4000);
        expect(computeBackoffMs(3, 1000, 60_000, () => 0.5)).toBe(3000);
    });

    it('is capped', () => {
        expect(computeBackoffMs(40, 1000, 60_000, () => 1)).toBe(60_000);
    });
});

describe('decideFailureOutcome', () => {
    const policy = { maxAttempts: 3, baseMs: 1000, capMs: 60_000 };
    const transient = new ProcessingError('store_unavailable', 'shard-b tidak terjangkau');

    it('parks permanent errors immediately', () => {
        const error = new ProcessingError('schema_incompatible', "field 'level' berubah dari number menjadi string");
        expect(decideFailureOutcome(1, error, policy)).toEqual({ kind: 'parked', error });
    });

    it('backs off retryable errors before max attempts', () => {
        expect(decideFailureOutcome(1, transient, policy, () => 1)).toEqual({
            kind: 'retry',
            error: transient,
            delayMs: 4000,
        });
    });

    it('parks with retry_exhausted when attempts run out', () => {
        const outcome = decideFailureOutcome(2, transient, policy);
        expect(outcome.kind).toBe('parked');
        if (outcome.kind !== 'parked') return;
        expect(outcome.error.category).toBe('retry_exhausted');
        expect(outcome.error.retryable).toBe(false);
        expect(outcome.error.reason).toBe(
            'retry_exhausted: percobaan habis setelah 3 kali; galat terakhir: store_unavailable: shard-b tidak terjangkau'
        );
    });
});
