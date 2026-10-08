import { createPublicKey, sign, verify } from 'crypto';

export interface JwtPayload {
    sub: string;
    sid: string;
    role: string;
    type: 'access' | 'refresh';
    iat: number;
    exp: number;
}

function encode(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function normalizePem(key: string): string {
    // Environment-file parsers may preserve `\\n` or double-escape it as
    // `\\\\n`. Both forms represent a PEM line break.
    return key.replace(/\\+n/g, '\n');
}

export function getJwtPublicKey(privateKey: string): string {
    return createPublicKey(normalizePem(privateKey)).export({ format: 'pem', type: 'spki' }).toString();
}

export function signJwt(payload: JwtPayload, privateKey: string): string {
    const encodedHeader = encode({ alg: 'RS256', typ: 'JWT' });
    const encodedPayload = encode(payload);
    const signedValue = `${encodedHeader}.${encodedPayload}`;
    const digitalSignature = sign('RSA-SHA256', Buffer.from(signedValue), normalizePem(privateKey));
    return `${signedValue}.${digitalSignature.toString('base64url')}`;
}

export function verifyJwt(token: string, publicKey: string): JwtPayload | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const signedValue = `${encodedHeader}.${encodedPayload}`;

    let header: { alg?: unknown; typ?: unknown };
    let actualSignature: Buffer;
    let payload: JwtPayload;
    try {
        header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown };
        actualSignature = Buffer.from(encodedSignature, 'base64url');
        payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as JwtPayload;
    } catch {
        return null;
    }

    if (
        header.alg !== 'RS256' ||
        header.typ !== 'JWT' ||
        !verify('RSA-SHA256', Buffer.from(signedValue), normalizePem(publicKey), actualSignature) ||
        payload.type === undefined ||
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.exp !== 'number' ||
        payload.exp <= Math.floor(Date.now() / 1000)
    ) {
        return null;
    }

    return payload;
}
