import { inject, injectable } from 'inversify';
import { TsunamiWarning } from '../clients/source-client.types';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { PendingTsunamiWarning, pendingTsunamiWarnings } from '../db/schema/pending-tsunami-warnings';

export interface IPendingTsunamiWarningRepository {
    findOldest(limit: number): Promise<PendingTsunamiWarning[]>;
    save(warning: TsunamiWarning): Promise<void>;
    remove(warningId: string): Promise<void>;
}

@injectable()
export class PendingTsunamiWarningRepository implements IPendingTsunamiWarningRepository {
    constructor(@inject(TYPES.Database) private readonly db: CanonicalStore) {}

    async findOldest(limit: number): Promise<PendingTsunamiWarning[]> {
        return this.db
            .collection<PendingTsunamiWarning>(pendingTsunamiWarnings)
            .find<PendingTsunamiWarning>({}, { projection: { _id: 0 } })
            .sort({ firstReceivedAt: 1 })
            .limit(limit)
            .toArray();
    }

    async save(warning: TsunamiWarning): Promise<void> {
        const now = new Date();
        await this.db.collection<PendingTsunamiWarning>(pendingTsunamiWarnings).updateOne(
            { _id: warning.warning_id },
            {
                $set: {
                    warningId: warning.warning_id,
                    relatedEventId: warning.related_event_id,
                    warning,
                    updatedAt: now,
                },
                $setOnInsert: { firstReceivedAt: now },
            },
            { upsert: true }
        );
    }

    async remove(warningId: string): Promise<void> {
        await this.db.collection<PendingTsunamiWarning>(pendingTsunamiWarnings).deleteOne({ _id: warningId });
    }
}
