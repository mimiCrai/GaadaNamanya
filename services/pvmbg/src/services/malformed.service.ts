import { inject, injectable } from 'inversify';
import { Logger } from 'pino';
import { TYPES } from '../constants/types';
import { MalformedKind } from '../types/contract';

export const DEFAULT_OVERSIZED_BYTES = 12 * 1024 * 1024;

export interface MalformedInjection {
    kind: MalformedKind;
    bytes: number;
}

export interface MalformedState {
    pending: MalformedInjection[];
    served: number;
}

// FIFO of malformed responses for the next n GET /volcanic-reports (P3 #3)
@injectable()
export class MalformedService {
    private readonly queue: MalformedInjection[] = [];
    private served = 0;

    constructor(@inject(TYPES.Logger) private readonly logger: Logger) {}

    enqueue(kind: MalformedKind, count: number, bytes = DEFAULT_OVERSIZED_BYTES): MalformedState {
        for (let i = 0; i < count; i++) this.queue.push({ kind, bytes });
        this.logger.warn({ kind, count, bytes, pending: this.queue.length }, 'PVMBG malformed responses queued');
        return this.state();
    }

    take(): MalformedInjection | undefined {
        const next = this.queue.shift();
        if (next) this.served++;
        return next;
    }

    state(): MalformedState {
        return { pending: this.queue.map((item) => ({ ...item })), served: this.served };
    }
}
