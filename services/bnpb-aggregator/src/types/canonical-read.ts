import { Document, Sort } from 'mongodb';
import { z } from 'zod';
import { HazardSource } from '../db/schema/hazard-events';

export const hazardReadQuerySchema = z.object({
    source: z.nativeEnum(HazardSource).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    cursor: z.string().min(1).max(4096).optional(),
});

export interface StorageRead<T> {
    items: T[];
    partial: boolean;
    unavailable_units: string[];
}

export interface CanonicalReadOptions {
    collection: string;
    filter?: Document;
    sort?: Sort;
    limit?: number;
    projection?: Document;
}

export interface HazardReadQuery {
    source?: string;
    since?: string;
    limit?: number;
    cursor?: string;
}

export class ReadApiError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly status = 400
    ) {
        super(message);
    }
}
