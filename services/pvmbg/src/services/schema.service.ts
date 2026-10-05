import { inject, injectable } from 'inversify';
import { Logger } from 'pino';
import { Clock, TYPES } from '../constants/types';
import { SchemaVersion } from '../types/contract';

export interface SchemaState {
    schema_version: SchemaVersion;
    changed_at: string;
}

// always v1 at startup
@injectable()
export class SchemaService {
    private current: SchemaVersion = 1;
    private changedAt: string;

    constructor(
        @inject(TYPES.Logger) private readonly logger: Logger,
        @inject(TYPES.Clock) private readonly clock: Clock
    ) {
        this.changedAt = new Date(this.clock()).toISOString();
    }

    get version(): SchemaVersion {
        return this.current;
    }

    set(version: SchemaVersion): SchemaState {
        if (version !== this.current) {
            const previous = this.current;
            this.current = version;
            this.changedAt = new Date(this.clock()).toISOString();
            this.logger.warn(
                { previous_version: previous, schema_version: version, changed_at: this.changedAt },
                'PVMBG schema version changed'
            );
        }
        return this.state();
    }

    state(): SchemaState {
        return { schema_version: this.current, changed_at: this.changedAt };
    }
}
