import { Logger } from 'pino';

export type AuthResult = 'ok' | 'missing' | 'invalid' | 'foreign_credential' | 'skipped';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Locals {
            correlationId: string;
            logger: Logger;
            authResult: AuthResult;
            injectedDelayMs: number;
        }
    }
}
