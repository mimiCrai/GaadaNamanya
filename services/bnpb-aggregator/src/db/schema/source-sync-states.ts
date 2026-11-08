export enum SourceStream {
    BmkgSeismic = 'BMKG_SEISMIC',
    BmkgTsunamiWarning = 'BMKG_TSUNAMI_WARNING',
    PvmbgVolcanic = 'PVMBG_VOLCANIC',
}

export enum SourceSyncStatus {
    Healthy = 'HEALTHY',
    Stale = 'STALE',
    Unavailable = 'UNAVAILABLE',
}

export const sourceSyncStates = 'source_sync_states';

export interface SourceSyncState {
    sourceStream: SourceStream;
    status: SourceSyncStatus;
    lastSuccessfulPollAt: Date | null;
    lastAttemptAt: Date | null;
    staleSince: Date | null;
    lastError: string | null;
    consecutiveFailures: number;
}
