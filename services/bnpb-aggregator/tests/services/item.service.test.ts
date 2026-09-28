import 'reflect-metadata';
import { ItemService } from '../../src/services/item.service';
import { IItemRepository } from '../../src/repositories/item.repository';
import { Item } from '../../src/db/schema/items';

// Mock the repository
const mockItemRepository: jest.Mocked<IItemRepository> = {
    findAll: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
};

describe('ItemService', () => {
    let itemService: ItemService;

    beforeEach(() => {
        jest.clearAllMocks();
        itemService = new ItemService(mockItemRepository);
    });

    describe('getAllItems', () => {
        it('should return all items', async () => {
            const mockItems: Item[] = [
                {
                    id: '1',
                    name: 'Item 1',
                    description: 'Description 1',
                    status: 'draft',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
                {
                    id: '2',
                    name: 'Item 2',
                    description: null,
                    status: 'published',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            ];

            mockItemRepository.findAll.mockResolvedValue(mockItems);

            const result = await itemService.getAllItems();

            expect(result).toEqual(mockItems);
            expect(mockItemRepository.findAll).toHaveBeenCalledTimes(1);
        });

        it('should return empty array when no items exist', async () => {
            mockItemRepository.findAll.mockResolvedValue([]);

            const result = await itemService.getAllItems();

            expect(result).toEqual([]);
        });
    });

    describe('getItemById', () => {
        it('should return item when found', async () => {
            const mockItem: Item = {
                id: '1',
                name: 'Item 1',
                description: 'Description 1',
                status: 'draft',
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            mockItemRepository.findById.mockResolvedValue(mockItem);

            const result = await itemService.getItemById('1');

            expect(result).toEqual(mockItem);
            expect(mockItemRepository.findById).toHaveBeenCalledWith('1');
        });

        it('should return null when item not found', async () => {
            mockItemRepository.findById.mockResolvedValue(undefined);

            const result = await itemService.getItemById('nonexistent');

            expect(result).toBeNull();
        });
    });

    describe('createItem', () => {
        it('should create and return new item', async () => {
            const createDto = { name: 'New Item', description: 'New Description' };
            const mockCreatedItem: Item = {
                id: '1',
                name: 'New Item',
                description: 'New Description',
                status: 'draft',
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            mockItemRepository.create.mockResolvedValue(mockCreatedItem);

            const result = await itemService.createItem(createDto);

            expect(result).toEqual(mockCreatedItem);
            expect(mockItemRepository.create).toHaveBeenCalledWith({
                name: 'New Item',
                description: 'New Description',
            });
        });

        it('should create item with null description when not provided', async () => {
            const createDto = { name: 'New Item' };
            const mockCreatedItem: Item = {
                id: '1',
                name: 'New Item',
                description: null,
                status: 'draft',
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            mockItemRepository.create.mockResolvedValue(mockCreatedItem);

            const result = await itemService.createItem(createDto);

            expect(result).toEqual(mockCreatedItem);
            expect(mockItemRepository.create).toHaveBeenCalledWith({
                name: 'New Item',
                description: null,
            });
        });
    });

    describe('deleteItem', () => {
        it('should return true when item is deleted', async () => {
            mockItemRepository.delete.mockResolvedValue(true);

            const result = await itemService.deleteItem('1');

            expect(result).toBe(true);
            expect(mockItemRepository.delete).toHaveBeenCalledWith('1');
        });

        it('should return false when item does not exist', async () => {
            mockItemRepository.delete.mockResolvedValue(false);

            const result = await itemService.deleteItem('nonexistent');

            expect(result).toBe(false);
        });
    });
});
