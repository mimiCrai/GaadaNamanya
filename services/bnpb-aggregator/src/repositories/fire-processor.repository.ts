import { inject, injectable } from 'inversify';
import { GridFSBucket, MongoServerError, ObjectId } from 'mongodb';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import {
    FIRE_SNAPSHOT_STATE_ID,
    FIRE_STATS_STATE_ID,
    FireSnapshotPointer,
    FireStatsState,
    fireProcessorState,
    fireSnapshotBucket,
    lateDetections,
    StoredLateDetection,
} from '../db/schema/fire-processor';
import { HazardSource, hazardEvents } from '../db/schema/hazard-events';
import { unprocessedMessages } from '../db/schema/unprocessed-messages';
import env from '../util/env';

export interface LateDetectionInput {
    offset: number;
    detectionKey: string;
    kind: 'detection' | 'update';
    eventTime: Date;
    watermark: Date;
    receivedAt: Date | null;
}

export interface SnapshotMeta {
    feedOffset: number;
    kafkaOffset: string | null;
}

export type SnapshotSave = { stored: true; pointer: FireSnapshotPointer } | { stored: false; current: number | null };

export class SnapshotTooLargeError extends Error {
    constructor(readonly limit: number) {
        super(`snapshot melebihi batas ${limit} byte`);
        this.name = 'SnapshotTooLargeError';
    }
}

export interface IFireProcessorRepository {
    recordLate(items: LateDetectionInput[], correlationId: string): Promise<{ inserted: number; existing: number }>;
    countLate(): Promise<number>;
    putStats(lastOffset: number, stats: Record<string, unknown>, instanceId: string | null): Promise<boolean>;
    getStats(): Promise<FireStatsState | null>;
    saveSnapshot(body: Readable, meta: SnapshotMeta, maxBytes: number): Promise<SnapshotSave>;
    openSnapshot(): Promise<{ pointer: FireSnapshotPointer; stream: Readable } | null>;
    countHazards(source: HazardSource): Promise<number>;
    countUnprocessed(source: string): Promise<Record<string, number>>;
}

const isDuplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000;

@injectable()
export class FireProcessorRepository implements IFireProcessorRepository {
    constructor(@inject(TYPES.Database) private readonly db: CanonicalStore) {}

    private bucket(): GridFSBucket {
        return new GridFSBucket(this.db.database, { bucketName: fireSnapshotBucket });
    }

    // idempotent per feed offset: a replay after a crash finds the first write
    async recordLate(items: LateDetectionInput[], correlationId: string): Promise<{ inserted: number; existing: number }> {
        if (!items.length) return { inserted: 0, existing: 0 };
        const storedAt = new Date();
        const result = await this.db.collection<StoredLateDetection>(lateDetections).bulkWrite(
            items.map((item) => ({
                updateOne: {
                    filter: { _id: `late-${item.offset}` },
                    update: {
                        $setOnInsert: {
                            offset: item.offset,
                            detectionKey: item.detectionKey,
                            kind: item.kind,
                            eventTime: item.eventTime,
                            watermark: item.watermark,
                            receivedAt: item.receivedAt,
                            storedAt,
                            correlationId,
                        },
                    },
                    upsert: true,
                },
            })),
            { ordered: false, timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS }
        );
        return { inserted: result.upsertedCount, existing: items.length - result.upsertedCount };
    }

    async countLate(): Promise<number> {
        return this.db.collection(lateDetections).countDocuments({}, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
    }

    // guard lastOffset >=: a stale instance cannot roll the published counters back
    async putStats(lastOffset: number, stats: Record<string, unknown>, instanceId: string | null): Promise<boolean> {
        try {
            await this.db.collection<FireStatsState>(fireProcessorState).updateOne(
                { _id: FIRE_STATS_STATE_ID, $or: [{ lastOffset: { $lte: lastOffset } }, { lastOffset: { $exists: false } }] },
                { $set: { lastOffset, stats, instanceId, updatedAt: new Date() } },
                { upsert: true, timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS }
            );
            return true;
        } catch (error) {
            if (isDuplicateKey(error)) return false;
            throw error;
        }
    }

    async getStats(): Promise<FireStatsState | null> {
        return this.db
            .collection<FireStatsState>(fireProcessorState)
            .findOne({ _id: FIRE_STATS_STATE_ID }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
    }

    // GridFS upload first (too large for a transaction), then an atomic pointer swap guarded by feedOffset >=
    async saveSnapshot(body: Readable, meta: SnapshotMeta, maxBytes: number): Promise<SnapshotSave> {
        const bucket = this.bucket();
        const id = new ObjectId();
        const hash = createHash('sha256');
        let size = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                size += chunk.length;
                if (size > maxBytes) return callback(new SnapshotTooLargeError(maxBytes));
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        const upload = bucket.openUploadStreamWithId(id, `fire-snapshot-${meta.feedOffset}`, {
            metadata: { feedOffset: meta.feedOffset, kafkaOffset: meta.kafkaOffset },
        });
        try {
            await pipeline(body, meter, upload);
        } catch (error) {
            await bucket.delete(id).catch(() => undefined);
            throw error;
        }
        const pointer: FireSnapshotPointer = {
            _id: FIRE_SNAPSHOT_STATE_ID,
            fileId: id.toHexString(),
            feedOffset: meta.feedOffset,
            kafkaOffset: meta.kafkaOffset,
            sha256: hash.digest('hex'),
            sizeBytes: size,
            savedAt: new Date(),
        };
        try {
            const previous = await this.db.collection<FireSnapshotPointer>(fireProcessorState).findOneAndUpdate(
                {
                    _id: FIRE_SNAPSHOT_STATE_ID,
                    $or: [{ feedOffset: { $lte: meta.feedOffset } }, { feedOffset: { $exists: false } }],
                },
                { $set: pointer },
                { upsert: true, returnDocument: 'before', timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS }
            );
            if (previous?.fileId && previous.fileId !== pointer.fileId) {
                await bucket.delete(new ObjectId(previous.fileId)).catch(() => undefined);
            }
            return { stored: true, pointer };
        } catch (error) {
            await bucket.delete(id).catch(() => undefined);
            if (!isDuplicateKey(error)) throw error;
            const current = await this.db
                .collection<FireSnapshotPointer>(fireProcessorState)
                .findOne({ _id: FIRE_SNAPSHOT_STATE_ID });
            return { stored: false, current: current?.feedOffset ?? null };
        }
    }

    async openSnapshot(): Promise<{ pointer: FireSnapshotPointer; stream: Readable } | null> {
        const pointer = await this.db
            .collection<FireSnapshotPointer>(fireProcessorState)
            .findOne({ _id: FIRE_SNAPSHOT_STATE_ID }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
        if (!pointer) return null;
        return { pointer, stream: this.bucket().openDownloadStream(new ObjectId(pointer.fileId)) };
    }

    async countHazards(source: HazardSource): Promise<number> {
        return this.db.collection(hazardEvents).countDocuments({ source }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
    }

    async countUnprocessed(source: string): Promise<Record<string, number>> {
        const rows = await this.db
            .collection(unprocessedMessages)
            .aggregate<{ _id: string; count: number }>(
                [{ $match: { source } }, { $group: { _id: '$status', count: { $sum: 1 } } }],
                { timeoutMS: env.STORAGE_READ_TIMEOUT_MS }
            )
            .toArray();
        return Object.fromEntries(rows.map((row) => [row._id, row.count]));
    }
}
