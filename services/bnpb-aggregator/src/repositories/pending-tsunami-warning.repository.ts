import { inject, injectable } from 'inversify';
import { TsunamiWarning } from '../clients/source-client.types';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { PendingTsunamiWarning, pendingTsunamiWarnings } from '../db/schema/pending-tsunami-warnings';
import { LeaseToken } from '../db/schema/background-leases';
import { IBackgroundLeaseRepository } from './background-lease.repository';

export interface IPendingTsunamiWarningRepository {
    findOldest(limit: number): Promise<PendingTsunamiWarning[]>;
    save(warning: TsunamiWarning, lease: LeaseToken): Promise<void>;
    remove(warningId: string, lease: LeaseToken): Promise<void>;
}

@injectable()
export class PendingTsunamiWarningRepository implements IPendingTsunamiWarningRepository {
    constructor(
        @inject(TYPES.Database) private readonly db: CanonicalStore,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository
    ) {}

    async findOldest(limit: number): Promise<PendingTsunamiWarning[]> {
        return this.db
            .collection<PendingTsunamiWarning>(pendingTsunamiWarnings)
            .find<PendingTsunamiWarning>({}, { projection: { _id: 0 } })
            .sort({ firstReceivedAt: 1 })
            .limit(limit)
            .toArray();
    }

    async save(warning: TsunamiWarning, lease: LeaseToken): Promise<void> {
        await this.leases.withLease(lease, async (session, now) => {
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
                { upsert: true, session }
            );
        });
    }

    async remove(warningId: string, lease: LeaseToken): Promise<void> {
        await this.leases.withLease(lease, async (session) => {
            await this.db
                .collection<PendingTsunamiWarning>(pendingTsunamiWarnings)
                .deleteOne({ _id: warningId }, { session });
        });
    }
}
