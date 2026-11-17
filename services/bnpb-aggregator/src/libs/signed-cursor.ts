import { createHmac, timingSafeEqual } from 'node:crypto';
import env from '../util/env';

export function encodeSignedCursor(value: unknown): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${createHmac('sha256', env.BNPB_INTERNAL_API_KEY).update(body).digest('base64url')}`;
}

export function decodeSignedCursor(cursor: string): unknown {
    if (cursor.length > 4096) throw new Error('Cursor too large');
    const parts = cursor.split('.');
    if (parts.length !== 2) throw new Error('Invalid cursor');
    const expected = createHmac('sha256', env.BNPB_INTERNAL_API_KEY).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid signature');
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
}
