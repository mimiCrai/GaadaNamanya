import { Response } from 'express';
import { controller, httpGet, response } from 'inversify-express-utils';
import { SERVICE_NAME } from '../libs/logger';

@controller('/health')
export class HealthController {
    @httpGet('/')
    getHealth(@response() res: Response) {
        return res.status(200).json({
            status: 'ok',
            service: SERVICE_NAME,
            uptime_s: Math.round(process.uptime()),
            time: new Date().toISOString(),
        });
    }
}
