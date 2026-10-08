import { UserRole } from '../db/schema/users';

export interface RegisterDto {
    email: string;
    password: string;
}

export type AdminUserRole = 'public' | 'lapangan' | 'internal' | 'admin';

export interface AdminCreateUserDto extends RegisterDto {
    role: AdminUserRole;
}

export interface AdminUpdateUserDto {
    email?: string;
    password?: string;
    role?: AdminUserRole;
}

export interface LoginDto {
    email: string;
    password: string;
}

export interface RefreshSessionDto {
    refreshToken: string;
}

export interface AuthUser {
    id: string;
    email: string;
    role: UserRole;
}

export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
    user: AuthUser;
}
