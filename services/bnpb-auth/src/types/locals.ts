declare global {
    namespace Express {
        interface Locals {
            correlationId: string;
        }
    }
}

export {};
