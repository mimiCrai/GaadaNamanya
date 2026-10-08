import { Response } from 'express';
import { controller, httpGet, response } from 'inversify-express-utils';
import env from '../util/env';
import { getJwtPublicKey } from '../util/jwt';

@controller('/')
export class PublicKeyController {
    @httpGet('/public-key')
    getPublicKey(@response() res: Response) {
        return res.type('application/x-pem-file').send(getJwtPublicKey(env.JWT_PRIVATE_KEY));
    }
}
