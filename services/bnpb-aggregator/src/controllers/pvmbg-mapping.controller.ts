import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IPvmbgMappingService } from '../services/pvmbg-mapping.service';

// per-replica view: the demo waits until every replica reports the same hash (D-36)
@controller('/internal/pvmbg/mapping', TYPES.InternalAuthMiddleware)
export class PvmbgMappingController {
    constructor(@inject(TYPES.IPvmbgMappingService) private readonly mapping: IPvmbgMappingService) {}

    @httpGet('/')
    status() {
        return this.mapping.status();
    }
}
