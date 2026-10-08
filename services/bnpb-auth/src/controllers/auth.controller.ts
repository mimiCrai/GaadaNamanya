import { Response } from 'express';
import { inject } from 'inversify';
import { controller, httpPost, requestBody, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { AuthError, IAuthService } from '../services/auth.service';
import { LoginDto, RefreshSessionDto, RegisterDto } from '../types/auth';

@controller('/auth')
export class AuthController {
    constructor(@inject(TYPES.IAuthService) private authService: IAuthService) {}

    @httpPost('/register')
    async register(@requestBody() body: RegisterDto, @response() res: Response) {
        try {
            const result = await this.authService.register(body);
            return res.status(201).json({ data: result });
        } catch (error) {
            return this.handleError(error, res);
        }
    }

    @httpPost('/login')
    async login(@requestBody() body: LoginDto, @response() res: Response) {
        try {
            const result = await this.authService.login(body);
            return res.json({ data: result });
        } catch (error) {
            return this.handleError(error, res);
        }
    }

    @httpPost('/refresh')
    async refresh(@requestBody() body: RefreshSessionDto, @response() res: Response) {
        try {
            const result = await this.authService.refresh(body);
            return res.json({ data: result });
        } catch (error) {
            return this.handleError(error, res);
        }
    }

    @httpPost('/logout')
    async logout(@requestBody() body: RefreshSessionDto, @response() res: Response) {
        try {
            await this.authService.logout(body);
            return res.status(204).send();
        } catch (error) {
            return this.handleError(error, res);
        }
    }

    private handleError(error: unknown, res: Response) {
        if (error instanceof AuthError) {
            return res.status(error.status).json({ error: { message: error.message } });
        }
        throw error;
    }
}
