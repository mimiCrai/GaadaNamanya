import { Request, Response } from 'express';
import { controller, httpGet } from 'inversify-express-utils';
import { metricsRegistry } from '../libs/metrics';

@controller('/metrics')
export class MetricsController {
    @httpGet('/')
    async metrics(_req: Request, res: Response) {
        res.setHeader('Content-Type', metricsRegistry.contentType);
        return res.send(await metricsRegistry.metrics());
    }
}
