import { inject } from 'inversify';
import {
    controller,
    httpGet,
    httpPost,
    httpPut,
    httpDelete,
    requestParam,
    requestBody,
    response,
} from 'inversify-express-utils';
import { Response } from 'express';
import { TYPES } from '../constants/types';
import { IItemService } from '../services/item.service';
import { CreateItemDto, UpdateItemDto } from '../types/item';

@controller('/items')
export class ItemController {
    constructor(@inject(TYPES.IItemService) private itemService: IItemService) {}

    @httpGet('/')
    async getAllItems(@response() res: Response) {
        const items = await this.itemService.getAllItems();
        return res.json({ data: items });
    }

    @httpGet('/:id')
    async getItemById(@requestParam('id') id: string, @response() res: Response) {
        const item = await this.itemService.getItemById(id);

        if (!item) {
            return res.status(404).json({ error: { message: 'Item not found' } });
        }

        return res.json({ data: item });
    }

    @httpPost('/')
    async createItem(@requestBody() body: CreateItemDto, @response() res: Response) {
        const item = await this.itemService.createItem(body);
        return res.status(201).json({ data: item });
    }

    @httpPut('/:id')
    async updateItem(@requestParam('id') id: string, @requestBody() body: UpdateItemDto, @response() res: Response) {
        const item = await this.itemService.updateItem(id, body);

        if (!item) {
            return res.status(404).json({ error: { message: 'Item not found' } });
        }

        return res.json({ data: item });
    }

    @httpDelete('/:id')
    async deleteItem(@requestParam('id') id: string, @response() res: Response) {
        const deleted = await this.itemService.deleteItem(id);

        if (!deleted) {
            return res.status(404).json({ error: { message: 'Item not found' } });
        }

        return res.status(204).send();
    }
}
