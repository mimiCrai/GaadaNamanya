import { generateKeyPairSync } from 'crypto';
import { getJwtPublicKey, signJwt, verifyJwt } from '../../src/util/jwt';

describe('JWT utility', () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ format: 'pem', type: 'pkcs8' })
        .toString();
    const publicKey = getJwtPublicKey(privateKey);
    const payload = {
        sub: 'user-id',
        sid: 'session-id',
        role: 'public',
        type: 'access' as const,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
    };

    it('creates a standard header.payload.signature RS256 JWT verifiable with the public key', () => {
        const token = signJwt(payload, privateKey);

        expect(token.split('.')).toHaveLength(3);
        expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(verifyJwt(token, publicKey)).toEqual(payload);
    });

    it('rejects a token whose payload has been changed', () => {
        const token = signJwt(payload, privateKey);
        const [header, , signature] = token.split('.');
        const changedPayload = Buffer.from(JSON.stringify({ ...payload, role: 'internal' })).toString('base64url');

        expect(verifyJwt(`${header}.${changedPayload}.${signature}`, publicKey)).toBeNull();
    });

    it('accepts a private key whose PEM line breaks were double-escaped', () => {
        const doubleEscapedPrivateKey = privateKey.replace(/\n/g, '\\\\n');
        const token = signJwt(payload, doubleEscapedPrivateKey);

        expect(verifyJwt(token, publicKey)).toEqual(payload);
    });
});
