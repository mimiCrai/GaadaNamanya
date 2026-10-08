import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { NewSession } from '../db/schema/sessions';
import { User, UserRole } from '../db/schema/users';
import { ISessionRepository } from '../repositories/session.repository';
import { IUserRepository } from '../repositories/user.repository';
import {
    AdminCreateUserDto,
    AdminUpdateUserDto,
    AuthResponse,
    AuthTokens,
    AuthUser,
    LoginDto,
    RefreshSessionDto,
    RegisterDto,
} from '../types/auth';
import env from '../util/env';
import { getJwtPublicKey, JwtPayload, signJwt, verifyJwt } from '../util/jwt';

const scrypt = promisify(scryptCallback);

export class AuthError extends Error {
    constructor(message: string, public readonly status = 401) {
        super(message);
    }
}

export interface IAuthService {
    register(dto: RegisterDto): Promise<AuthResponse>;
    login(dto: LoginDto): Promise<AuthResponse>;
    refresh(dto: RefreshSessionDto): Promise<AuthTokens>;
    logout(dto: RefreshSessionDto): Promise<void>;
    listUsers(authorization: string | undefined): Promise<AuthUser[]>;
    getUser(authorization: string | undefined, id: string): Promise<AuthUser>;
    createUser(authorization: string | undefined, dto: AdminCreateUserDto): Promise<AuthUser>;
    updateUser(authorization: string | undefined, id: string, dto: AdminUpdateUserDto): Promise<AuthUser>;
    deleteUser(authorization: string | undefined, id: string): Promise<void>;
}

@injectable()
export class AuthService implements IAuthService {
    constructor(
        @inject(TYPES.IUserRepository) private userRepository: IUserRepository,
        @inject(TYPES.ISessionRepository) private sessionRepository: ISessionRepository
    ) {}

    async register(dto: RegisterDto): Promise<AuthResponse> {
        const email = dto.email.trim().toLowerCase();
        const existing = await this.userRepository.findByEmail(email);
        if (existing) throw new AuthError('Email is already registered', 409);

        // This public endpoint never accepts a caller-selected role.
        const user = await this.userRepository.create({
            email,
            passwordHash: await hashPassword(dto.password),
            role: 'public',
        });
        return { user: toAuthUser(user), ...(await this.createSession(user)) };
    }

    async login(dto: LoginDto): Promise<AuthResponse> {
        const user = await this.userRepository.findByEmail(dto.email.trim().toLowerCase());
        if (!user || !(await verifyPassword(dto.password, user.passwordHash))) {
            throw new AuthError('Invalid email or password');
        }

        return { user: toAuthUser(user), ...(await this.createSession(user)) };
    }

    async refresh(dto: RefreshSessionDto): Promise<AuthTokens> {
        const payload = this.readRefreshToken(dto.refreshToken);
        const session = await this.sessionRepository.findById(payload.sid);
        if (
            !session ||
            session.userId !== payload.sub ||
            session.revokedAt !== null ||
            session.expiresAt <= new Date() ||
            !safeEqual(hashToken(dto.refreshToken), session.refreshTokenHash)
        ) {
            throw new AuthError('Invalid refresh token');
        }

        const user = await this.userRepository.findById(session.userId);
        if (!user) throw new AuthError('User no longer exists');

        await this.sessionRepository.revoke(session.id);
        return this.createSession(user);
    }

    async logout(dto: RefreshSessionDto): Promise<void> {
        const payload = this.readRefreshToken(dto.refreshToken);
        const session = await this.sessionRepository.findById(payload.sid);
        if (
            session &&
            session.userId === payload.sub &&
            safeEqual(hashToken(dto.refreshToken), session.refreshTokenHash)
        ) {
            await this.sessionRepository.revoke(session.id);
        }
    }

    async listUsers(authorization: string | undefined): Promise<AuthUser[]> {
        await this.requireAdmin(authorization);
        return (await this.userRepository.findAll()).map(toAuthUser);
    }

    async getUser(authorization: string | undefined, id: string): Promise<AuthUser> {
        await this.requireAdmin(authorization);
        const user = await this.userRepository.findById(id);
        if (!user) throw new AuthError('User not found', 404);
        return toAuthUser(user);
    }

    async createUser(authorization: string | undefined, dto: AdminCreateUserDto): Promise<AuthUser> {
        await this.requireAdmin(authorization);
        const email = dto.email.trim().toLowerCase();
        if (await this.userRepository.findByEmail(email)) throw new AuthError('Email is already registered', 409);
        const user = await this.userRepository.create({ email, passwordHash: await hashPassword(dto.password), role: dto.role });
        return toAuthUser(user);
    }

    async updateUser(authorization: string | undefined, id: string, dto: AdminUpdateUserDto): Promise<AuthUser> {
        await this.requireAdmin(authorization);
        const updates: Parameters<IUserRepository['update']>[1] = {};
        if (dto.email !== undefined) {
            const email = dto.email.trim().toLowerCase();
            const existing = await this.userRepository.findByEmail(email);
            if (existing && existing.id !== id) throw new AuthError('Email is already registered', 409);
            updates.email = email;
        }
        if (dto.password !== undefined) updates.passwordHash = await hashPassword(dto.password);
        if (dto.role !== undefined) updates.role = dto.role;

        const user = await this.userRepository.update(id, updates);
        if (!user) throw new AuthError('User not found', 404);
        return toAuthUser(user);
    }

    async deleteUser(authorization: string | undefined, id: string): Promise<void> {
        const admin = await this.requireAdmin(authorization);
        if (admin.sub === id) throw new AuthError('Administrators cannot delete their own account', 400);
        if (!(await this.userRepository.delete(id))) throw new AuthError('User not found', 404);
    }

    private async createSession(user: User): Promise<AuthTokens> {
        const now = Math.floor(Date.now() / 1000);
        const sessionId = randomUUID();
        const refreshPayload: JwtPayload = {
            sub: user.id,
            sid: sessionId,
            role: user.role,
            type: 'refresh',
            iat: now,
            exp: now + env.JWT_REFRESH_TTL_SECONDS,
        };
        const refreshToken = signJwt(refreshPayload, env.JWT_PRIVATE_KEY);
        const session: NewSession = {
            id: sessionId,
            userId: user.id,
            refreshTokenHash: hashToken(refreshToken),
            expiresAt: new Date(refreshPayload.exp * 1000),
        };
        await this.sessionRepository.create(session);

        return {
            accessToken: signJwt(
                {
                    sub: user.id,
                    sid: sessionId,
                    role: user.role,
                    type: 'access',
                    iat: now,
                    exp: now + env.JWT_ACCESS_TTL_SECONDS,
                },
                env.JWT_PRIVATE_KEY
            ),
            refreshToken,
        };
    }

    private readRefreshToken(token: string): JwtPayload {
        const payload = verifyJwt(token, getJwtPublicKey(env.JWT_PRIVATE_KEY));
        if (!payload || payload.type !== 'refresh') throw new AuthError('Invalid refresh token');
        return payload;
    }

    private async requireAdmin(authorization: string | undefined): Promise<JwtPayload> {
        const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
        const payload = token ? verifyJwt(token, getJwtPublicKey(env.JWT_PRIVATE_KEY)) : null;
        if (!payload || payload.type !== 'access') throw new AuthError('Missing or invalid access token');
        if (payload.role !== 'admin') throw new AuthError('Administrator role required', 403);
        const user = await this.userRepository.findById(payload.sub);
        if (!user || user.role !== 'admin') throw new AuthError('Administrator role required', 403);
        return payload;
    }
}

async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('base64url');
    const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt}$${derivedKey.toString('base64url')}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    const [algorithm, salt, encodedKey] = storedHash.split('$');
    if (algorithm !== 'scrypt' || !salt || !encodedKey) return false;

    const expectedKey = Buffer.from(encodedKey, 'base64url');
    const derivedKey = (await scrypt(password, salt, expectedKey.length)) as Buffer;
    return derivedKey.length === expectedKey.length && timingSafeEqual(derivedKey, expectedKey);
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function toAuthUser(user: User): AuthUser {
    return { id: user.id, email: user.email, role: user.role as UserRole };
}
