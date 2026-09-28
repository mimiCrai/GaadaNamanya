import { injectable, inject } from 'inversify';
import { TYPES } from '../constants/types';
import { Item, NewItem } from '../db/schema/items';
import { IItemRepository } from '../repositories/item.repository';
import { CreateItemDto, UpdateItemDto } from '../types/item';

export interface IItemService {
    getAllItems(): Promise<Item[]>;
    getItemById(id: string): Promise<Item | null>;
    createItem(dto: CreateItemDto): Promise<Item>;
    updateItem(id: string, dto: UpdateItemDto): Promise<Item | null>;
    deleteItem(id: string): Promise<boolean>;
}

@injectable()
export class ItemService implements IItemService {
    constructor(@inject(TYPES.IItemRepository) private itemRepository: IItemRepository) {}

    async getAllItems() {
        return this.itemRepository.findAll();
    }

    async getItemById(id: string) {
        const item = await this.itemRepository.findById(id);
        return item ?? null;
    }

    async createItem(dto: CreateItemDto) {
        const newItem: NewItem = {
            name: dto.name,
            description: dto.description ?? null,
        };
        return this.itemRepository.create(newItem);
    }

    async updateItem(id: string, dto: UpdateItemDto) {
        const existing = await this.itemRepository.findById(id);
        if (!existing) {
            return null;
        }

        const updated = await this.itemRepository.update(id, {
            ...(dto.name && { name: dto.name }),
            ...(dto.description !== undefined && { description: dto.description }),
        });

        return updated ?? null;
    }

    async deleteItem(id: string) {
        return this.itemRepository.delete(id);
    }
}
