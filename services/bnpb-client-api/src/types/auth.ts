export const USER_ROLES = ['public', 'lapangan', 'internal'] as const;

export type UserRole = (typeof USER_ROLES)[number];

export interface AuthContext {
    sub: string;
    sid: string;
    role: UserRole;
}
