import { verify } from 'crypto';
import { injectable } from 'inversify';
import { ApiError } from '../errors/api-error';
import { logger } from '../libs/logger';
import { AuthContext, USER_ROLES, UserRole } from '../types/auth';
import env from '../util/env';

interface JwtPayload extends AuthContext {
    type: unknown;
    iat: unknown;
    exp: unknown;
}

export interface IJwtAuthenticator {
    authenticate(authorization: string | undefined, correlationId: string): Promise<AuthContext>;
}

@injectable()
export class JwtAuthenticator implements IJwtAuthenticator {
    async authenticate(authorization: string | undefined, correlationId: string): Promise<AuthContext> {
        const token = readBearerToken(authorization);
        const publicKey = await this.fetchPublicKey(correlationId);
        const payload = verifyAccessToken(token, publicKey);

        return { sub: payload.sub, sid: payload.sid, role: payload.role };
    }

    private async fetchPublicKey(correlationId: string): Promise<string> {
        let response: Response;
        const startedAt = Date.now();
        try {
            response = await fetch(env.BNPB_AUTH_PUBLIC_KEY_URL, {
                headers: { accept: 'application/x-pem-file', 'X-Correlation-ID': correlationId },
            });
        } catch {
            logger.error(
                { target: 'bnpb-auth', path: '/public-key', correlationId, latencyMs: Date.now() - startedAt },
                'Outgoing request failed'
            );
            throw new ApiError('Authentication service is unavailable', 502);
        }

        logger.info(
            {
                target: 'bnpb-auth',
                path: '/public-key',
                status: response.status,
                correlationId,
                latencyMs: Date.now() - startedAt,
            },
            'Outgoing request completed'
        );

        if (!response.ok) throw new ApiError('Authentication service is unavailable', 502);

        const publicKey = await response.text();
        if (!publicKey.includes('-----BEGIN PUBLIC KEY-----')) {
            throw new ApiError('Authentication service returned an invalid public key', 502);
        }
        return publicKey;
    }
}

function readBearerToken(authorization: string | undefined): string {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new ApiError('Missing or invalid Authorization header', 401);
    return match[1];
}

function verifyAccessToken(token: string, publicKey: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3) throw new ApiError('Invalid access token', 401);

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    try {
        const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown };
        const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as JwtPayload;
        const signature = Buffer.from(encodedSignature, 'base64url');
        const signedValue = `${encodedHeader}.${encodedPayload}`;

        if (
            header.alg !== 'RS256' ||
            header.typ !== 'JWT' ||
            !verify('RSA-SHA256', Buffer.from(signedValue), publicKey, signature) ||
            typeof payload.sub !== 'string' ||
            typeof payload.sid !== 'string' ||
            !USER_ROLES.includes(payload.role as UserRole) ||
            payload.type !== 'access' ||
            typeof payload.exp !== 'number' ||
            payload.exp <= Math.floor(Date.now() / 1000)
        ) {
            throw new ApiError('Invalid access token', 401);
        }

        return payload;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('Invalid access token', 401);
    }
}
