import { Response } from 'express';
import { controller, httpGet, response } from 'inversify-express-utils';
import { metricsRegistry } from '../libs/metrics';

@controller('/metrics')
export class MetricsController {
    @httpGet('/')
    async metrics(@response() res: Response) {
        res.type(metricsRegistry.contentType).send(await metricsRegistry.metrics());
    }
}
