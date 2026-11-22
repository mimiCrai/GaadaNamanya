import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { TYPES } from '../constants/types';
import { IFireConsumer } from '../services/fire-consumer.service';

// engine counters and runtime of this instance (the stored copy is GET /internal/satellite/summary)
@controller('/status')
export class StatusController {
    constructor(@inject(TYPES.IFireConsumer) private readonly consumer: IFireConsumer) {}

    @httpGet('/')
    status() {
        return this.consumer.stats();
    }
}
