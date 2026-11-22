import 'reflect-metadata';
import { MongoNetworkError, MongoServerError, ObjectId } from 'mongodb';
import { Readable, Writable } from 'node:stream';
import { FireSnapshotPointer } from '../../src/db/schema/fire-processor';
import { FireProcessorRepository } from '../../src/repositories/fire-processor.repository';

// GridFS stand-in: a file exists once its upload stream finished
class FakeBucket {
    readonly files = new Map<string, number>();

    openUploadStreamWithId(id: ObjectId, _name: string, options: { metadata: { feedOffset: number } }) {
        return new Writable({
            write: (_chunk, _encoding, callback) => callback(),
            final: (callback) => {
                this.files.set(id.toHexString(), options.metadata.feedOffset);
                callback();
            },
        });
    }

    async delete(id: ObjectId) {
        this.files.delete(id.toHexString());
    }

    find(filter: { 'metadata.feedOffset': { $lt: number }; _id: { $ne: ObjectId } }) {
        const below = filter['metadata.feedOffset'].$lt;
        const keep = filter._id.$ne.toHexString();
        const rows = [...this.files]
            .filter(([id, offset]) => offset < below && id !== keep)
            .map(([id]) => ({ _id: new ObjectId(id) }));
        return { toArray: async () => rows };
    }
}

type Fault = 'none' | 'lost-reply' | 'not-applied';

// pointer document with the same >= guard as Mongo; faults model a write whose reply never arrives
class FakePointerState {
    doc: FireSnapshotPointer | null = null;
    fault: Fault = 'none';
    readFails = false;

    async updateOne(
        filter: { $or: [{ feedOffset: { $lte: number } }, unknown] },
        update: { $set: FireSnapshotPointer }
    ) {
        const fault = this.fault;
        this.fault = 'none';
        if (fault === 'not-applied') throw new MongoNetworkError('connection reset');
        const limit = filter.$or[0].feedOffset.$lte;
        if (this.doc && this.doc.feedOffset > limit)
            throw new MongoServerError({ message: 'E11000 duplicate key', code: 11000 });
        this.doc = { ...update.$set };
        if (fault === 'lost-reply') throw new MongoNetworkError('connection reset after commit');
        return { matchedCount: 1 };
    }

    async findOne() {
        if (this.readFails) throw new MongoNetworkError('still down');
        return this.doc ? { ...this.doc } : null;
    }
}

describe('FireProcessorRepository.saveSnapshot (P4.5 crash safety)', () => {
    let bucket: FakeBucket;
    let state: FakePointerState;
    let repository: FireProcessorRepository;
    const save = (feedOffset: number) =>
        repository.saveSnapshot(
            Readable.from([Buffer.from(`snapshot-${feedOffset}`)]),
            { feedOffset, kafkaOffset: String(feedOffset) },
            1024
        );

    beforeEach(() => {
        bucket = new FakeBucket();
        state = new FakePointerState();
        repository = new FireProcessorRepository({ collection: () => state } as never);
        jest.spyOn(repository as never as { bucket: () => FakeBucket }, 'bucket').mockReturnValue(bucket);
    });

    it('a normal swap stores the pointer and drops the blobs below it', async () => {
        await save(10);
        const saved = await save(20);
        expect(saved).toMatchObject({ stored: true, pointer: { feedOffset: 20 } });
        expect([...bucket.files.keys()]).toEqual([state.doc!.fileId]);
    });

    it('a pointer that committed but whose reply was lost keeps its blob and counts as stored', async () => {
        await save(10);
        state.fault = 'lost-reply';
        const saved = await save(20);
        expect(saved).toMatchObject({ stored: true, pointer: { feedOffset: 20 } });
        expect(bucket.files.has(state.doc!.fileId)).toBe(true);
    });

    it('an unknown outcome (reply lost and the read fails too) keeps the blob, so restore never hits a deleted file', async () => {
        await save(10);
        state.fault = 'lost-reply';
        state.readFails = true;
        await expect(save(20)).rejects.toBeInstanceOf(MongoNetworkError);
        expect(state.doc!.feedOffset).toBe(20);
        expect(bucket.files.has(state.doc!.fileId)).toBe(true);
    });

    it('the orphan of an unknown outcome is collected by the next stored snapshot', async () => {
        await save(10);
        state.fault = 'not-applied';
        state.readFails = true;
        await expect(save(20)).rejects.toBeInstanceOf(MongoNetworkError);
        expect(bucket.files.size).toBe(2);
        state.readFails = false;
        await save(30);
        expect([...bucket.files.keys()]).toEqual([state.doc!.fileId]);
    });

    it('a write that surely did not apply, behind a newer pointer, drops its own blob and reports stale', async () => {
        await save(30);
        state.fault = 'not-applied';
        await expect(save(20)).resolves.toEqual({ stored: false, current: 30 });
        expect([...bucket.files.keys()]).toEqual([state.doc!.fileId]);
    });

    it('a stale snapshot rejected by the guard (duplicate key) drops its blob and reports the stored offset', async () => {
        await save(30);
        await expect(save(20)).resolves.toEqual({ stored: false, current: 30 });
        expect(bucket.files.size).toBe(1);
    });
});
