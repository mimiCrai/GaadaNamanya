import 'reflect-metadata';
import { AuthError, AuthService } from '../../src/services/auth.service';
import { ISessionRepository } from '../../src/repositories/session.repository';
import { IUserRepository } from '../../src/repositories/user.repository';
import { User } from '../../src/db/schema/users';
import { signJwt } from '../../src/util/jwt';
import env from '../../src/util/env';

const mockUserRepository: jest.Mocked<IUserRepository> = {
    findAll: jest.fn(),
    findByEmail: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
};

const mockSessionRepository: jest.Mocked<ISessionRepository> = {
    create: jest.fn(),
    findById: jest.fn(),
    revoke: jest.fn(),
};

const user: User = {
    id: '7e17c35c-a70d-4c6d-81f5-0ea9e0c18a8e',
    email: 'user@example.com',
    passwordHash: 'scrypt$invalid$invalid',
    role: 'public',
    createdAt: new Date(),
    updatedAt: new Date(),
};

describe('AuthService', () => {
    let authService: AuthService;

    beforeEach(() => {
        jest.clearAllMocks();
        authService = new AuthService(mockUserRepository, mockSessionRepository);
        mockSessionRepository.create.mockImplementation(async (session) => ({
            id: session.id ?? 'session-id',
            userId: session.userId,
            refreshTokenHash: session.refreshTokenHash,
            expiresAt: session.expiresAt,
            createdAt: new Date(),
            revokedAt: null,
        }));
    });

    it('registers only a public user, even if a caller supplies a role', async () => {
        mockUserRepository.findByEmail.mockResolvedValue(undefined);
        mockUserRepository.create.mockResolvedValue(user);

        const result = await authService.register({
            email: ' USER@Example.com ',
            password: 'correct horse battery staple',
            // Deliberately bypass the DTO at runtime to prove role elevation is ignored.
            ...({ role: 'admin' } as object),
        });

        expect(mockUserRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'user@example.com',
                role: 'public',
                passwordHash: expect.stringMatching(/^scrypt\$/),
            })
        );
        expect(result.user.role).toBe('public');
    });

    it('rejects invalid credentials', async () => {
        mockUserRepository.findByEmail.mockResolvedValue(undefined);

        await expect(authService.login({ email: user.email, password: 'not-the-password' })).rejects.toThrow(
            new AuthError('Invalid email or password')
        );
    });

    it('creates accounts only for a current administrator', async () => {
        const admin = { ...user, role: 'admin' as const };
        mockUserRepository.findById.mockResolvedValue(admin);
        mockUserRepository.findByEmail.mockResolvedValue(undefined);
        mockUserRepository.create.mockResolvedValue({ ...user, role: 'lapangan' });

        const now = Math.floor(Date.now() / 1000);
        const token = signJwt(
            { sub: admin.id, sid: 'admin-session', role: 'admin', type: 'access', iat: now, exp: now + 60 },
            env.JWT_PRIVATE_KEY
        );
        const result = await authService.createUser(`Bearer ${token}`, {
            email: 'field@example.com',
            password: 'correct horse battery staple',
            role: 'lapangan',
        });

        expect(result.role).toBe('lapangan');
        expect(mockUserRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({ email: 'field@example.com', role: 'lapangan', passwordHash: expect.stringMatching(/^scrypt\$/) })
        );
    });

    it('rejects account creation by a non-admin', async () => {
        const now = Math.floor(Date.now() / 1000);
        const token = signJwt(
            { sub: user.id, sid: 'user-session', role: 'public', type: 'access', iat: now, exp: now + 60 },
            env.JWT_PRIVATE_KEY
        );
        await expect(
            authService.createUser(`Bearer ${token}`, {
                email: 'field@example.com',
                password: 'correct horse battery staple',
                role: 'lapangan',
            })
        ).rejects.toMatchObject({ status: 403 });
        expect(mockUserRepository.create).not.toHaveBeenCalled();
    });
});
