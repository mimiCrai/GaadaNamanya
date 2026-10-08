import 'reflect-metadata';
import { Response } from 'express';
import { PublicKeyController } from '../../src/controllers/public-key.controller';
import { signJwt, verifyJwt } from '../../src/util/jwt';
import env from '../../src/util/env';

describe('AuthController', () => {
    it('returns the public key that verifies RS256 JWT signatures', () => {
        const res = {
            type: jest.fn().mockReturnThis(),
            send: jest.fn(),
        } as unknown as Response;
        const controller = new PublicKeyController();

        controller.getPublicKey(res);

        expect(res.type).toHaveBeenCalledWith('application/x-pem-file');
        const publicKey = (res.send as jest.Mock).mock.calls[0][0] as string;
        expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);

        const now = Math.floor(Date.now() / 1000);
        const token = signJwt(
            { sub: 'user-id', sid: 'session-id', role: 'public', type: 'access', iat: now, exp: now + 60 },
            env.JWT_PRIVATE_KEY
        );
        expect(verifyJwt(token, publicKey)?.sub).toBe('user-id');
    });
});
