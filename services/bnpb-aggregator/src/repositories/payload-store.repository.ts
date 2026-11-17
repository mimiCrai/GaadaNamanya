import { once } from 'node:events';
import { Readable } from 'node:stream';
import { inject, injectable } from 'inversify';
import { GridFSBucket, ObjectId } from 'mongodb';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { unprocessedPayloadBucket } from '../db/schema/unprocessed-messages';
import { OverflowSink, PayloadRef } from '../libs/safe-decode';

export interface IPayloadStore {
    openSink(metadata: Record<string, unknown>): OverflowSink;
    openDownload(ref: ObjectId): Readable;
    readAll(ref: ObjectId, maxBytes: number): Promise<Buffer>;
    delete(ref: ObjectId): Promise<void>;
}

@injectable()
export class PayloadStore implements IPayloadStore {
    constructor(@inject(TYPES.Database) private readonly store: CanonicalStore) {}

    private bucket(): GridFSBucket {
        return new GridFSBucket(this.store.database, { bucketName: unprocessedPayloadBucket });
    }

    openSink(metadata: Record<string, unknown>): OverflowSink {
        const id = new ObjectId();
        const upload = this.bucket().openUploadStreamWithId(id, `payload-${id.toHexString()}`, { metadata });
        let failure: unknown;
        upload.on('error', (error) => {
            failure = error;
        });
        return {
            async write(chunk: Buffer) {
                if (failure) throw failure;
                if (!upload.write(chunk)) await once(upload, 'drain');
            },
            async finish(): Promise<PayloadRef> {
                if (failure) throw failure;
                upload.end();
                await once(upload, 'finish');
                return { id: id.toHexString() };
            },
            async abort() {
                await upload.abort().catch(() => undefined);
            },
        };
    }

    openDownload(ref: ObjectId): Readable {
        return this.bucket().openDownloadStream(ref);
    }

    async readAll(ref: ObjectId, maxBytes: number): Promise<Buffer> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of this.openDownload(ref)) {
            size += (chunk as Buffer).length;
            if (size > maxBytes) throw new Error(`Payload ${ref.toHexString()} exceeds ${maxBytes} bytes`);
            chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks, size);
    }

    async delete(ref: ObjectId): Promise<void> {
        await this.bucket()
            .delete(ref)
            .catch(() => undefined);
    }
}
