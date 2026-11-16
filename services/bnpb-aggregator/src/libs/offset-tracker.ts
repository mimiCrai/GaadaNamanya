export type Placement<T> =
    | { kind: 'accept'; placed: Array<{ offset: number; value: T }>; orphans: T[] }
    | { kind: 'duplicate'; offset: number }
    | { kind: 'gap'; expected: number; received: number; unplaced: number };

export class OffsetTracker<T> {
    private lastOffset: number;
    private held: T[] = [];

    /** @param lastDurable last offset durable in the broker, -1 when nothing has been written yet. */
    constructor(lastDurable: number) {
        if (!Number.isSafeInteger(lastDurable) || lastDurable < -1) throw new RangeError('invalid last offset');
        this.lastOffset = lastDurable;
    }

    get last(): number {
        return this.lastOffset;
    }

    get expected(): number {
        return this.lastOffset + 1;
    }

    get unplacedCount(): number {
        return this.held.length;
    }

    holdUnplaced(value: T): void {
        this.held.push(value);
    }

    accept(offset: number, value: T): Placement<T> {
        if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('invalid offset');
        if (offset <= this.lastOffset) return { kind: 'duplicate', offset };

        const missing = offset - this.lastOffset - 1;
        const held = this.held;
        if (missing === held.length) {
            const placed = held.map((item, index) => ({ offset: this.lastOffset + 1 + index, value: item }));
            placed.push({ offset, value });
            this.held = [];
            this.lastOffset = offset;
            return { kind: 'accept', placed, orphans: [] };
        }
        if (missing === 0) {
            this.held = [];
            this.lastOffset = offset;
            return { kind: 'accept', placed: [{ offset, value }], orphans: held };
        }
        return { kind: 'gap', expected: this.lastOffset + 1, received: offset, unplaced: held.length };
    }
}
