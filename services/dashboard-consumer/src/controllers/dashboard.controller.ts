import { Request, Response } from 'express';
import { controller, httpGet } from 'inversify-express-utils';
import path from 'path';

@controller('/dashboard')
export class DashboardController {
    @httpGet('/')
    async getPage(_req: Request, res: Response) {
        return res.sendFile(path.join(process.cwd(), 'public', 'dashboard.html'));
    }
}
