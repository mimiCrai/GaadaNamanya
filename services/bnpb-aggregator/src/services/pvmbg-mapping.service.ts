import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { logger } from '../libs/logger';
import { pvmbgMappingInfo, pvmbgMappingReloadFailuresTotal } from '../libs/metrics';
import { BUILTIN_MAPPING, CompiledMapping, parseMappingFile } from '../libs/pvmbg-mapping';
import env from '../util/env';
import { IBackgroundLeadershipService } from './background-leadership.service';

export interface PvmbgMappingStatus {
    instance_id: string;
    path: string;
    hash: string;
    label: string;
    source: CompiledMapping['source'];
    loaded_at: string;
    last_checked_at: string | null;
    last_error: string | null;
    mapping: CompiledMapping['file'];
}

export interface IPvmbgMappingService {
    active(): CompiledMapping;
    status(): PvmbgMappingStatus;
    checkNow(): Promise<boolean>;
    start(): void;
    stop(): void;
}

// Every replica polls the file content hash (fs.watch misses Docker Desktop bind mounts and ConfigMap symlink swaps).
@injectable()
export class PvmbgMappingService implements IPvmbgMappingService {
    private current: CompiledMapping = BUILTIN_MAPPING;
    private loadedAt = new Date();
    private lastCheckedAt: Date | null = null;
    private lastError: string | null = null;
    private rejectedHash: string | null = null;
    private timer: NodeJS.Timeout | undefined;
    private checking = false;
    private path = env.PVMBG_MAPPING_PATH;
    private intervalMs = env.PVMBG_MAPPING_POLL_MS;

    constructor(@inject(TYPES.IBackgroundLeadershipService) private readonly leadership: IBackgroundLeadershipService) {
        this.publishInfo();
    }

    // tests and tooling only
    useFile(path: string, intervalMs = this.intervalMs): this {
        this.path = path;
        this.intervalMs = intervalMs;
        return this;
    }

    active(): CompiledMapping {
        return this.current;
    }

    status(): PvmbgMappingStatus {
        return {
            instance_id: this.leadership.instanceId,
            path: this.path,
            hash: this.current.hash,
            label: this.current.label,
            source: this.current.source,
            loaded_at: this.loadedAt.toISOString(),
            last_checked_at: this.lastCheckedAt?.toISOString() ?? null,
            last_error: this.lastError,
            mapping: this.current.file,
        };
    }

    start(): void {
        if (this.timer) return;
        void this.checkNow();
        this.timer = setInterval(() => void this.checkNow(), this.intervalMs);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    // returns true when a new mapping became active
    async checkNow(): Promise<boolean> {
        if (this.checking) return false;
        this.checking = true;
        try {
            let bytes: Buffer;
            try {
                bytes = await readFile(this.path);
            } catch (error) {
                this.reject(null, `mapping tidak bisa dibaca (${this.path}): ${(error as Error).message}`);
                return false;
            }
            const hash = createHash('sha256').update(bytes).digest('hex');
            if (hash === this.current.hash || hash === this.rejectedHash) return false;
            try {
                const next = parseMappingFile(bytes);
                const previous = this.current;
                this.current = next;
                this.loadedAt = new Date();
                this.lastError = null;
                this.rejectedHash = null;
                this.publishInfo();
                logger.info(
                    { path: this.path, hash: next.hash, label: next.label, previousHash: previous.hash },
                    'PVMBG mapping loaded'
                );
                return true;
            } catch (error) {
                this.reject(hash, (error as Error).message);
                return false;
            }
        } finally {
            this.lastCheckedAt = new Date();
            this.checking = false;
        }
    }

    // invalid or unreadable file: keep the active mapping, count the failure once per distinct problem
    private reject(hash: string | null, message: string): void {
        if (this.lastError === message && this.rejectedHash === hash) return;
        this.lastError = message;
        this.rejectedHash = hash;
        pvmbgMappingReloadFailuresTotal.inc();
        logger.error(
            { path: this.path, hash, activeHash: this.current.hash, error: message },
            'PVMBG mapping rejected; keeping the active mapping'
        );
    }

    private publishInfo(): void {
        pvmbgMappingInfo.reset();
        pvmbgMappingInfo.set({ hash: this.current.hash, label: this.current.label, source: this.current.source }, 1);
    }
}
