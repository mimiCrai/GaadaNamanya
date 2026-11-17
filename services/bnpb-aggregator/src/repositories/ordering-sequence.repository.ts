import { inject, injectable } from 'inversify';
import { CanonicalStore } from '../db';
import { TYPES } from '../constants/types';
import { OrderingSequence, orderingSequences } from '../db/schema/ordering-sequences';

export interface IOrderingSequenceRepository {
    next(name: string): Promise<number>;
}

@injectable()
export class OrderingSequenceRepository implements IOrderingSequenceRepository {
    constructor(@inject(TYPES.Database) private readonly db: CanonicalStore) {}

    async next(name: string): Promise<number> {
        const doc = await this.db
            .collection<OrderingSequence>(orderingSequences)
            .findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
        if (!doc || !Number.isSafeInteger(doc.value)) throw new Error(`ordering sequence ${name} unavailable`);
        return doc.value;
    }
}
