import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IBackgroundLeaseRepository } from '../repositories/background-lease.repository';
import { IBackgroundLeadershipService } from '../services/background-leadership.service';

@controller('/internal/leadership', TYPES.InternalAuthMiddleware)
export class LeadershipController {
    constructor(
        @inject(TYPES.IBackgroundLeadershipService) private readonly leadership: IBackgroundLeadershipService,
        @inject(TYPES.IBackgroundLeaseRepository) private readonly leases: IBackgroundLeaseRepository
    ) {}

    @httpGet('/')
    async getStatus() {
        return { instanceId: this.leadership.instanceId, lease: await this.leases.inspect() };
    }
}
