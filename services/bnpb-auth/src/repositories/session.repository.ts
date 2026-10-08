import { eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import { NewSession, Session, sessions } from '../db/schema/sessions';

export interface ISessionRepository {
    create(session: NewSession): Promise<Session>;
    findById(id: string): Promise<Session | undefined>;
    revoke(id: string): Promise<void>;
}

@injectable()
export class SessionRepository implements ISessionRepository {
    constructor(@inject(TYPES.Database) private db: NodePgDatabase<typeof schema>) {}

    async create(session: NewSession): Promise<Session> {
        const result = await this.db.insert(sessions).values(session).returning();
        return result[0];
    }

    async findById(id: string): Promise<Session | undefined> {
        const result = await this.db.select().from(sessions).where(eq(sessions.id, id));
        return result[0];
    }

    async revoke(id: string): Promise<void> {
        await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
    }
}
