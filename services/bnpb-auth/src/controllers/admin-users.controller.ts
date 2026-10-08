import { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpDelete, httpGet, httpPatch, httpPost, request, requestBody, requestParam, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { AuthError, IAuthService } from '../services/auth.service';
import { AdminCreateUserDto, AdminUpdateUserDto } from '../types/auth';

@controller('/admin/users')
export class AdminUsersController {
    constructor(@inject(TYPES.IAuthService) private readonly authService: IAuthService) {}

    @httpGet('/')
    async list(@request() req: Request, @response() res: Response) {
        return this.respond(res, () => this.authService.listUsers(req.header('authorization')));
    }

    @httpGet('/:id')
    async get(@requestParam('id') id: string, @request() req: Request, @response() res: Response) {
        return this.respond(res, () => this.authService.getUser(req.header('authorization'), id));
    }

    @httpPost('/')
    async create(@requestBody() body: AdminCreateUserDto, @request() req: Request, @response() res: Response) {
        try {
            return res.status(201).json({ data: await this.authService.createUser(req.header('authorization'), body) });
        } catch (error) {
            return this.handleError(error, res);
        }
    }

    @httpPatch('/:id')
    async update(@requestParam('id') id: string, @requestBody() body: AdminUpdateUserDto, @request() req: Request, @response() res: Response) {
        return this.respond(res, () => this.authService.updateUser(req.header('authorization'), id, body));
    }

    @httpDelete('/:id')
    async delete(@requestParam('id') id: string, @request() req: Request, @response() res: Response) {
        try {
            await this.authService.deleteUser(req.header('authorization'), id);
            return res.status(204).send();
        } catch (error) {
            return this.handleError(error, res);
        }
    }

    private async respond(res: Response, action: () => Promise<unknown>) {
        try {
            return res.json({ data: await action() });
        } catch (error) {
            return this.handleError(error, res);
        }
    }

    private handleError(error: unknown, res: Response) {
        if (error instanceof AuthError) return res.status(error.status).json({ error: { message: error.message } });
        throw error;
    }
}
