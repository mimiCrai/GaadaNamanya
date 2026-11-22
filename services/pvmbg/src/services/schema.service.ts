import { inject, injectable } from 'inversify';
import { Logger } from 'pino';
import { Clock, TYPES } from '../constants/types';
import { SchemaMode, SchemaVersion } from '../types/contract';

export interface SchemaState {
    schema_version: SchemaVersion;
    changed_at: string;
}

export interface SchemaModeState extends SchemaState {
    mode: SchemaMode;
}

export function versionOfMode(mode: SchemaMode): SchemaVersion {
    return mode === 'v1' ? 1 : 2;
}

// always v1 at startup
@injectable()
export class SchemaService {
    private currentMode: SchemaMode = 'v1';
    private changedAt: string;

    constructor(
        @inject(TYPES.Logger) private readonly logger: Logger,
        @inject(TYPES.Clock) private readonly clock: Clock
    ) {
        this.changedAt = new Date(this.clock()).toISOString();
    }

    get version(): SchemaVersion {
        return versionOfMode(this.currentMode);
    }

    get mode(): SchemaMode {
        return this.currentMode;
    }

    // M1 body {version}: response shape unchanged
    set(version: SchemaVersion): SchemaState {
        this.apply(version === 1 ? 'v1' : 'v2_confidence');
        return this.state();
    }

    setMode(mode: SchemaMode): SchemaModeState {
        this.apply(mode);
        return { ...this.state(), mode: this.currentMode };
    }

    state(): SchemaState {
        return { schema_version: this.version, changed_at: this.changedAt };
    }

    private apply(mode: SchemaMode): void {
        if (mode === this.currentMode) return;
        const previous = this.currentMode;
        this.currentMode = mode;
        this.changedAt = new Date(this.clock()).toISOString();
        this.logger.warn(
            {
                previous_version: versionOfMode(previous),
                schema_version: this.version,
                previous_mode: previous,
                mode,
                changed_at: this.changedAt,
            },
            'PVMBG schema version changed'
        );
    }
}
