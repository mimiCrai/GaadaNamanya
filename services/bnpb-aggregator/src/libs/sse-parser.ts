const LF = 0x0a;
const CR = 0x0d;
const COLON = 0x3a;
const SPACE = 0x20;
const NUL = 0x00;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DIGITS = /^[0-9]+$/;

export type SseItem =
    | {
          type: 'event';
          // `id` field set inside this event block
          id: string | null;
          // sticky last-event-ID buffer after this block (the SSE `lastEventId`). 
          lastEventId: string;
          // event type
          event: string;
          // all `data` lines joined with LF, exact bytes
          data: Buffer;
          // bytes of the event block including line terminators
          bytes: number;
      }
    | { type: 'retry'; ms: number }
    | { type: 'comment'; text: string }
    | {
          type: 'oversized';
          id: string | null;
          bytes: number;
      }
    | {
          // End of stream in the middle of an event. Not dispatched, per the spec; reported for logging.
          type: 'incomplete';
          bytes: number;
      };

export interface SseParserOptions {
    maxEventBytes: number;
}

export class SseParser {
    private readonly maxEventBytes: number;

    // Current, not yet terminated line.
    private lineParts: Buffer[] = [];
    private lineBytes = 0;
    private skipLeadingLf = false;
    private firstLine = true;

    // Current event block.
    private dataParts: Buffer[] = [];
    private dataFields = 0;
    private eventType = '';
    private blockId: string | null = null;
    private blockBytes = 0;
    private lastEventId = '';

    // Oversized event being skipped until the next blank line.
    private discarding = false;
    private discardLineHasContent = false;

    private out: SseItem[] = [];

    constructor(options: SseParserOptions) {
        if (!Number.isInteger(options.maxEventBytes) || options.maxEventBytes < 1) {
            throw new RangeError('maxEventBytes must be a positive integer');
        }
        this.maxEventBytes = options.maxEventBytes;
    }

    // Bytes currently held by the parser (for tests and memory assertions).
    get bufferedBytes(): number {
        return this.lineBytes + this.dataParts.reduce((sum, part) => sum + part.length, 0);
    }

    push(chunk: Uint8Array): SseItem[] {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        this.out = [];
        let position = 0;

        if (this.skipLeadingLf && bytes.length > 0) {
            this.skipLeadingLf = false;
            if (bytes[0] === LF) position = 1;
        }

        while (position < bytes.length) {
            const terminator = nextLineTerminator(bytes, position);
            if (terminator < 0) {
                this.appendToLine(bytes.subarray(position));
                break;
            }
            this.appendToLine(bytes.subarray(position, terminator));
            this.completeLine();
            if (bytes[terminator] === CR) {
                if (terminator + 1 < bytes.length) {
                    position = bytes[terminator + 1] === LF ? terminator + 2 : terminator + 1;
                } else {
                    this.skipLeadingLf = true;
                    position = terminator + 1;
                }
            } else {
                position = terminator + 1;
            }
        }

        const items = this.out;
        this.out = [];
        return items;
    }

    end(): SseItem[] {
        const pending = this.discarding ? 0 : this.blockBytes + this.lineBytes;
        const items: SseItem[] = pending > 0 ? [{ type: 'incomplete', bytes: pending }] : [];
        this.lineParts = [];
        this.lineBytes = 0;
        this.skipLeadingLf = false;
        this.firstLine = true;
        this.resetBlock();
        this.lastEventId = '';
        this.discarding = false;
        this.discardLineHasContent = false;
        return items;
    }

    private appendToLine(part: Buffer): void {
        if (part.length === 0) return;
        if (this.discarding) {
            this.discardLineHasContent = true;
            return;
        }
        if (this.blockBytes + this.lineBytes + part.length > this.maxEventBytes) {
            this.startDiscarding(this.blockBytes + this.lineBytes + part.length);
            return;
        }
        // Copy: a subarray would keep the whole network chunk alive.
        this.lineParts.push(Buffer.from(part));
        this.lineBytes += part.length;
    }

    private startDiscarding(bytesSeen: number): void {
        this.out.push({ type: 'oversized', id: this.blockId, bytes: bytesSeen });
        this.lineParts = [];
        this.lineBytes = 0;
        this.resetBlock();
        this.discarding = true;
        this.discardLineHasContent = true;
    }

    private completeLine(): void {
        if (this.discarding) {
            const blank = !this.discardLineHasContent;
            this.discardLineHasContent = false;
            this.firstLine = false;
            if (blank) this.discarding = false;
            return;
        }

        let line = this.lineParts.length === 1 ? this.lineParts[0] : Buffer.concat(this.lineParts, this.lineBytes);
        this.lineParts = [];
        this.lineBytes = 0;
        if (this.firstLine) {
            this.firstLine = false;
            if (line.subarray(0, BOM.length).equals(BOM)) line = line.subarray(BOM.length);
        }
        this.blockBytes += line.length + 1;

        if (line.length === 0) {
            this.dispatch();
            return;
        }
        if (line[0] === COLON) {
            this.out.push({ type: 'comment', text: stripOneSpace(line.subarray(1)).toString('utf8') });
            return;
        }

        const colon = line.indexOf(COLON);
        const name = (colon < 0 ? line : line.subarray(0, colon)).toString('latin1');
        const value = colon < 0 ? Buffer.alloc(0) : stripOneSpace(line.subarray(colon + 1));
        this.processField(name, value);
    }

    private processField(name: string, value: Buffer): void {
        switch (name) {
            case 'event':
                this.eventType = value.toString('utf8');
                return;
            case 'data':
                this.dataParts.push(value);
                this.dataFields++;
                return;
            case 'id':
                if (value.includes(NUL)) return;
                this.blockId = value.toString('utf8');
                this.lastEventId = this.blockId;
                return;
            case 'retry': {
                const text = value.toString('latin1');
                if (DIGITS.test(text)) this.out.push({ type: 'retry', ms: Number(text) });
                return;
            }
            default:
                return; // Unknown fields are ignored.
        }
    }

    private dispatch(): void {
        if (this.dataFields > 0) {
            const parts: Buffer[] = [];
            this.dataParts.forEach((part, index) => {
                if (index > 0) parts.push(Buffer.from([LF]));
                parts.push(part);
            });
            this.out.push({
                type: 'event',
                id: this.blockId,
                lastEventId: this.lastEventId,
                event: this.eventType === '' ? 'message' : this.eventType,
                data: Buffer.concat(parts),
                bytes: this.blockBytes,
            });
        }
        this.resetBlock();
    }

    private resetBlock(): void {
        this.dataParts = [];
        this.dataFields = 0;
        this.eventType = '';
        this.blockId = null;
        this.blockBytes = 0;
    }
}

function nextLineTerminator(bytes: Buffer, from: number): number {
    const lf = bytes.indexOf(LF, from);
    const cr = bytes.indexOf(CR, from);
    if (lf < 0) return cr;
    if (cr < 0) return lf;
    return Math.min(lf, cr);
}

function stripOneSpace(value: Buffer): Buffer {
    return value.length > 0 && value[0] === SPACE ? value.subarray(1) : value;
}
