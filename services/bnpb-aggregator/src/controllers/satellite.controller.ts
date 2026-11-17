import { Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost, response } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { ISatelliteIngestService } from '../services/satellite-ingest.service';

@controller('/internal/satellite', TYPES.InternalAuthMiddleware)
export class SatelliteController {
    constructor(@inject(TYPES.ISatelliteIngestService) private readonly ingest: ISatelliteIngestService) {}

    @httpGet('/status')
    status() {
        return this.ingest.status();
    }

    @httpPost('/disconnect')
    disconnect(@response() res: Response) {
        if (this.ingest.disconnect()) return res.status(202).json({ disconnected: true });
        return res
            .status(409)
            .json({ error: { code: 'conflict', message: 'Instance ini tidak sedang memegang stream satelit' } });
    }
}
