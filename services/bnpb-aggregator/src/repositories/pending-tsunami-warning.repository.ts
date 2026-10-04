import { asc, eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inject, injectable } from 'inversify';
import { TsunamiWarning } from '../clients/source-client.types';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import { PendingTsunamiWarning, pendingTsunamiWarnings } from '../db/schema/pending-tsunami-warnings';

export interface IPendingTsunamiWarningRepository {
    findOldest(limit: number): Promise<PendingTsunamiWarning[]>;
    save(warning: TsunamiWarning): Promise<void>;
    remove(warningId: string): Promise<void>;
}

@injectable()
export class PendingTsunamiWarningRepository implements IPendingTsunamiWarningRepository {
    constructor(@inject(TYPES.Database) private readonly db: NodePgDatabase<typeof schema>) {}

    async findOldest(limit: number): Promise<PendingTsunamiWarning[]> {
        return this.db
            .select()
            .from(pendingTsunamiWarnings)
            .orderBy(asc(pendingTsunamiWarnings.firstReceivedAt))
            .limit(limit);
    }

    async save(warning: TsunamiWarning): Promise<void> {
        const now = new Date();
        await this.db
            .insert(pendingTsunamiWarnings)
            .values({
                warningId: warning.warning_id,
                relatedEventId: warning.related_event_id,
                warning,
                firstReceivedAt: now,
                updatedAt: now,
            })
            .onConflictDoUpdate({
                target: pendingTsunamiWarnings.warningId,
                set: {
                    relatedEventId: warning.related_event_id,
                    warning,
                    updatedAt: now,
                },
            });
    }

    async remove(warningId: string): Promise<void> {
        await this.db.delete(pendingTsunamiWarnings).where(eq(pendingTsunamiWarnings.warningId, warningId));
    }
}
