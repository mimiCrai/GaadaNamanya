import { asc, eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TYPES } from '../constants/types';
import * as schema from '../db/schema';
import { NewUser, User, users } from '../db/schema/users';

export interface IUserRepository {
    findAll(): Promise<User[]>;
    findByEmail(email: string): Promise<User | undefined>;
    findById(id: string): Promise<User | undefined>;
    create(user: NewUser): Promise<User>;
    update(id: string, user: Partial<Pick<NewUser, 'email' | 'passwordHash' | 'role'>>): Promise<User | undefined>;
    delete(id: string): Promise<boolean>;
}

@injectable()
export class UserRepository implements IUserRepository {
    constructor(@inject(TYPES.Database) private db: NodePgDatabase<typeof schema>) {}

    async findAll(): Promise<User[]> {
        return this.db.select().from(users).orderBy(asc(users.email));
    }

    async findByEmail(email: string): Promise<User | undefined> {
        const result = await this.db.select().from(users).where(eq(users.email, email));
        return result[0];
    }

    async findById(id: string): Promise<User | undefined> {
        const result = await this.db.select().from(users).where(eq(users.id, id));
        return result[0];
    }

    async create(user: NewUser): Promise<User> {
        const result = await this.db.insert(users).values(user).returning();
        return result[0];
    }

    async update(id: string, user: Partial<Pick<NewUser, 'email' | 'passwordHash' | 'role'>>): Promise<User | undefined> {
        const result = await this.db
            .update(users)
            .set({ ...user, updatedAt: new Date() })
            .where(eq(users.id, id))
            .returning();
        return result[0];
    }

    async delete(id: string): Promise<boolean> {
        const result = await this.db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
        return result.length > 0;
    }
}
