import { generateKeyPairSync, sign } from 'crypto';
import { JwtAuthenticator } from '../../src/services/jwt-authenticator.service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const correlationId = '11111111-1111-4111-8111-111111111111';

function accessToken(role: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-id', sid: 'session-id', role, type: 'access', iat: 1, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    const signedValue = `${header}.${payload}`;
    return `${signedValue}.${sign('RSA-SHA256', Buffer.from(signedValue), privatePem).toString('base64url')}`;
}

describe('JwtAuthenticator', () => {
    const fetchMock = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = fetchMock;
        fetchMock.mockImplementation(() => Promise.resolve(new Response(publicPem, { status: 200 })));
    });

    it('fetches the auth public key for every request and verifies an RS256 access token', async () => {
        const authenticator = new JwtAuthenticator();
        await expect(authenticator.authenticate(`Bearer ${accessToken('public')}`, correlationId)).resolves.toEqual({ sub: 'user-id', sid: 'session-id', role: 'public' });
        await authenticator.authenticate(`Bearer ${accessToken('lapangan')}`, correlationId);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { 'X-Correlation-ID': correlationId } });
    });

    it('rejects an unknown role', async () => {
        await expect(new JwtAuthenticator().authenticate(`Bearer ${accessToken('admin')}`, correlationId)).rejects.toMatchObject({ status: 401 });
    });
});
