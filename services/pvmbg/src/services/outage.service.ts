import { Response } from 'express';
import { inject, injectable } from 'inversify';
import { Logger } from 'pino';
import { Clock, TYPES } from '../constants/types';
import { sendError } from '../libs/http-error';
import { OutageMode } from '../types/contract';
import '../types/locals';

export interface OutageState {
    enabled: boolean;
    mode: OutageMode;
    since: string | null;
    held_requests: number;
}

export interface OutageChange extends OutageState {
    released_requests: number;
}

@injectable()
export class OutageService {
    private enabled = false;
    private mode: OutageMode = 'error';
    private since: string | null = null;
    private readonly held = new Set<Response>();

    constructor(
        @inject(TYPES.Logger) private readonly logger: Logger,
        @inject(TYPES.Clock) private readonly clock: Clock
    ) {}

    get active(): OutageMode | undefined {
        return this.enabled ? this.mode : undefined;
    }

    get heldCount(): number {
        return this.held.size;
    }

    hold(res: Response): void {
        this.held.add(res);
        res.once('close', () => this.held.delete(res));
    }

    set(enabled: boolean, mode: OutageMode): OutageChange {
        const previous = { enabled: this.enabled, mode: this.mode };

        const released = enabled && mode === 'hang' ? 0 : this.releaseAll();

        if (enabled && !this.enabled) {
            this.since = new Date(this.clock()).toISOString();
        }
        if (!enabled) {
            this.since = null;
        }
        this.enabled = enabled;
        this.mode = mode;

        const change = { ...this.state(), released_requests: released };
        if (previous.enabled !== enabled || (enabled && previous.mode !== mode)) {
            this.logger.warn({ previous, ...change }, enabled ? 'PVMBG outage started' : 'PVMBG outage ended');
        }
        return change;
    }

    // answers every still-open request with 503 
    releaseAll(): number {
        let released = 0;
        for (const res of this.held) {
            if (!res.headersSent && !res.writableEnded) {
                sendError(res, 503, 'service_unavailable', 'PVMBG outage ended before this request was answered');
                released++;
            }
        }
        this.held.clear();
        return released;
    }

    state(): OutageState {
        return { enabled: this.enabled, mode: this.mode, since: this.since, held_requests: this.held.size };
    }
}
