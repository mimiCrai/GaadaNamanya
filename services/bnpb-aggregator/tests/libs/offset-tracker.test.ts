import { OffsetTracker } from '../../src/libs/offset-tracker';

describe('OffsetTracker', () => {
    it('accepts exactly last+1, starting after the durable checkpoint', () => {
        const tracker = new OffsetTracker<string>(41);
        expect(tracker.expected).toBe(42);
        expect(tracker.accept(42, 'a')).toEqual({ kind: 'accept', placed: [{ offset: 42, value: 'a' }], orphans: [] });
        expect(tracker.accept(43, 'b').kind).toBe('accept');
        expect(tracker.last).toBe(43);
    });

    it('starts at 0 on an empty log', () => {
        const tracker = new OffsetTracker<string>(-1);
        expect(tracker.accept(0, 'a').kind).toBe('accept');
    });

    it('drops offsets <= last as duplicates without moving', () => {
        const tracker = new OffsetTracker<string>(10);
        expect(tracker.accept(10, 'x')).toEqual({ kind: 'duplicate', offset: 10 });
        expect(tracker.accept(3, 'x')).toEqual({ kind: 'duplicate', offset: 3 });
        expect(tracker.last).toBe(10);
    });

    it('reports a gap without moving', () => {
        const tracker = new OffsetTracker<string>(10);
        expect(tracker.accept(13, 'x')).toEqual({ kind: 'gap', expected: 11, received: 13, unplaced: 0 });
        expect(tracker.last).toBe(10);
        expect(tracker.accept(11, 'y').kind).toBe('accept');
    });

    it('attributes held blocks to the missing offsets in order when the counts match', () => {
        const tracker = new OffsetTracker<string>(4);
        tracker.holdUnplaced('broken-5');
        tracker.holdUnplaced('broken-6');
        expect(tracker.accept(7, 'ok-7')).toEqual({
            kind: 'accept',
            placed: [
                { offset: 5, value: 'broken-5' },
                { offset: 6, value: 'broken-6' },
                { offset: 7, value: 'ok-7' },
            ],
            orphans: [],
        });
        expect(tracker.unplacedCount).toBe(0);
    });

    it('returns held blocks as orphans when no offset is missing', () => {
        const tracker = new OffsetTracker<string>(4);
        tracker.holdUnplaced('junk');
        expect(tracker.accept(5, 'ok')).toEqual({
            kind: 'accept',
            placed: [{ offset: 5, value: 'ok' }],
            orphans: ['junk'],
        });
    });

    it('treats a count mismatch as a real gap', () => {
        const tracker = new OffsetTracker<string>(4);
        tracker.holdUnplaced('broken');
        expect(tracker.accept(8, 'ok')).toEqual({ kind: 'gap', expected: 5, received: 8, unplaced: 1 });
    });

    it('rejects invalid input', () => {
        expect(() => new OffsetTracker(-2)).toThrow(RangeError);
        expect(() => new OffsetTracker<string>(0).accept(1.5, 'x')).toThrow(RangeError);
    });
});
