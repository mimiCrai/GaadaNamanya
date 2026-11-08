import { inject, injectable } from 'inversify';
import { Document, Long } from 'mongodb';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { IStorageTopologyService } from '../services/storage-topology.service';
import { CanonicalReadOptions, StorageRead } from '../types/canonical-read';
import { logger } from '../libs/logger';
import env from '../util/env';

export interface ICanonicalReadRepository {
    read<T>(options: CanonicalReadOptions, consume?: (batch: T[]) => void): Promise<StorageRead<T>>;
}

@injectable()
export class CanonicalReadRepository implements ICanonicalReadRepository {
    constructor(
        @inject(TYPES.Database) private readonly store: CanonicalStore,
        @inject(TYPES.IStorageTopologyService) private readonly topology: IStorageTopologyService
    ) {}

    async read<T>(options: CanonicalReadOptions, consume?: (batch: T[]) => void): Promise<StorageRead<T>> {
        const status = await this.topology.inspect();
        const unavailable = new Set(status.unavailable_units);
        const items: T[] = [];
        let partial = unavailable.size > 0;
        let cursorId = Long.ZERO;
        const started = Date.now();
        const session = this.store.client.startSession();
        try {
            let command: Document = {
                find: options.collection,
                filter: options.filter ?? {},
                sort: options.sort ?? { ingestedAt: 1, hazardId: 1 },
                projection: options.projection ?? { _id: 0 },
                ...(options.limit ? { limit: options.limit } : {}),
                batchSize: Math.min(options.limit ?? 500, 500),
                collation: { locale: 'simple' },
                allowPartialResults: true,
            };
            do {
                const remaining = env.STORAGE_READ_TIMEOUT_MS - (Date.now() - started);
                if (remaining <= 0) throw new Error('Storage read deadline exceeded');
                const result = await this.store.database.command(
                    { ...command, ...(command.find ? { maxTimeMS: remaining } : {}) },
                    { session, timeoutMS: remaining }
                );
                const cursor = result.cursor;
                cursorId = Long.fromValue(cursor.id);
                if (cursor.partialResultsReturned || result.partialResultsReturned) {
                    partial = true;
                    if (unavailable.size === 0) unavailable.add('canonical-store');
                }
                const batch: T[] = cursor.firstBatch ?? cursor.nextBatch;
                if (consume) consume(batch);
                else items.push(...batch);
                command = { getMore: cursorId, collection: options.collection, batchSize: 500 };
            } while (!cursorId.isZero());
        } catch (error) {
            partial = true;
            if (unavailable.size === 0) unavailable.add('canonical-store');
            logger.warn(
                { collection: options.collection, unavailableUnits: [...unavailable], error },
                'Returning incomplete storage read'
            );
        } finally {
            if (!cursorId.isZero()) {
                await this.store.database
                    .command({ killCursors: options.collection, cursors: [cursorId] }, { session, timeoutMS: 200 })
                    .catch(() => undefined);
            }
            await session.endSession();
        }
        return { items, partial, unavailable_units: [...unavailable].sort() };
    }
}
