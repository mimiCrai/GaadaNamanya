import { injectable, inject } from 'inversify';
import { eq } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TYPES } from '../constants/types';
import { items, Item, NewItem } from '../db/schema/items';
import * as schema from '../db/schema';

export interface IItemRepository {
    findAll(): Promise<Item[]>;
    findById(id: string): Promise<Item | undefined>;
    create(item: NewItem): Promise<Item>;
    update(id: string, item: Partial<NewItem>): Promise<Item | undefined>;
    delete(id: string): Promise<boolean>;
}

@injectable()
export class ItemRepository implements IItemRepository {
    constructor(@inject(TYPES.Database) private db: NodePgDatabase<typeof schema>) {}

    async findAll(): Promise<Item[]> {
        return this.db.select().from(items);
    }

    async findById(id: string): Promise<Item | undefined> {
        const result = await this.db.select().from(items).where(eq(items.id, id));
        return result[0];
    }

    async create(data: NewItem): Promise<Item> {
        const result = await this.db.insert(items).values(data).returning();
        return result[0];
    }

    async update(id: string, data: Partial<NewItem>): Promise<Item | undefined> {
        const result = await this.db
            .update(items)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(items.id, id))
            .returning();
        return result[0];
    }

    async delete(id: string): Promise<boolean> {
        const result = await this.db.delete(items).where(eq(items.id, id)).returning();
        return result.length > 0;
    }
}
