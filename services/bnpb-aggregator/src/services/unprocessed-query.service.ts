import { inject, injectable } from 'inversify';
import { Document } from 'mongodb';
import { z } from 'zod';
import { TYPES } from '../constants/types';
import { UnprocessedMessage, UnprocessedStatus, unprocessedMessages } from '../db/schema/unprocessed-messages';
import { decodeSignedCursor, encodeSignedCursor } from '../libs/signed-cursor';
import { ICanonicalReadRepository } from '../repositories/canonical-read.repository';
import { IUnprocessedMessageRepository } from '../repositories/unprocessed-message.repository';
import { ReadApiError } from '../types/canonical-read';
import env from '../util/env';

export const OPEN_STATUSES: readonly UnprocessedStatus[] = ['retrying', 'parked'];

const cursorSchema = z
    .object({
        v: z.literal(1),
        mode: z.enum(['unprocessed', 'dlq']),
        source: z.string().nullable(),
        status: z.string().nullable(),
        time: z.string().datetime(),
        id: z.string().min(1),
        units: z.array(z.string()),
    })
    .strict();
type Cursor = z.infer<typeof cursorSchema>;

export interface UnprocessedPageQuery {
    source?: string;
    status?: UnprocessedStatus;
    limit?: number;
    cursor?: string;
}

export interface IUnprocessedQueryService {
    audit(query: UnprocessedPageQuery): Promise<Record<string, unknown>>;
    list(query: UnprocessedPageQuery): Promise<Record<string, unknown>>;
    detail(messageId: string): Promise<Record<string, unknown> | null>;
    entry(messageId: string): Promise<UnprocessedMessage | null>;
}

const LIST_PROJECTION = { _id: 0, payload: 0, history: 0 };

@injectable()
export class UnprocessedQueryService implements IUnprocessedQueryService {
    constructor(
        @inject(TYPES.ICanonicalReadRepository) private readonly reader: ICanonicalReadRepository,
        @inject(TYPES.IUnprocessedMessageRepository) private readonly repository: IUnprocessedMessageRepository
    ) {}

    async audit(query: UnprocessedPageQuery): Promise<Record<string, unknown>> {
        const page = await this.page('unprocessed', { ...query, status: undefined });
        return {
            items: page.items.map(toAuditItem),
            next_cursor: page.nextCursor,
            partial: page.partial,
            unavailable_units: page.unavailable_units,
        };
    }

    async list(query: UnprocessedPageQuery): Promise<Record<string, unknown>> {
        const page = await this.page('dlq', query);
        return {
            items: page.items.map(toInspectionItem),
            next_cursor: page.nextCursor,
            partial: page.partial,
            unavailable_units: page.unavailable_units,
        };
    }

    async entry(messageId: string): Promise<UnprocessedMessage | null> {
        try {
            return await this.repository.findById(messageId);
        } catch {
            throw new ReadApiError('unavailable', 'Unprocessed message storage is temporarily unavailable', 503);
        }
    }

    async detail(messageId: string): Promise<Record<string, unknown> | null> {
        const entry = await this.entry(messageId);
        if (!entry) return null;
        const inline = entry.sizeBytes <= env.DLQ_INSPECT_MAX_BYTES;
        let payloadBase64: string | null = null;
        if (inline) {
            try {
                payloadBase64 = (await this.repository.readPayload(entry, env.DLQ_INSPECT_MAX_BYTES)).toString(
                    'base64'
                );
            } catch {
                throw new ReadApiError('unavailable', 'Payload storage is temporarily unavailable', 503);
            }
        }
        return {
            ...toInspectionItem(entry),
            history: entry.history.map((item) => ({ ...item, at: item.at.toISOString() })),
            payload_encoding: 'base64',
            payload_base64: payloadBase64,
            payload_truncated: !inline,
            payload_storage: entry.payloadRef ? 'gridfs' : 'inline',
            raw_url: `/internal/dlq/${encodeURIComponent(entry.messageId)}/raw`,
        };
    }

    private async page(mode: Cursor['mode'], query: UnprocessedPageQuery) {
        const limit = query.limit ?? 100;
        const conditions: Document[] = [
            { status: query.status ? query.status : { $in: [...OPEN_STATUSES] } },
            ...(query.source ? [{ source: query.source }] : []),
        ];
        let previous: Cursor | undefined;
        if (query.cursor) {
            previous = this.decodeCursor(query.cursor);
            if (
                previous.mode !== mode ||
                previous.source !== (query.source ?? null) ||
                previous.status !== (query.status ?? null)
            ) {
                throw new ReadApiError('bad_request', 'Cursor does not match this query');
            }
            const time = new Date(previous.time);
            conditions.push({ $or: [{ receivedAt: { $gt: time } }, { receivedAt: time, _id: { $gt: previous.id } }] });
        }
        const result = await this.reader.read<UnprocessedMessage>({
            collection: unprocessedMessages,
            filter: { $and: conditions },
            sort: { receivedAt: 1, _id: 1 },
            projection: LIST_PROJECTION,
            limit: limit + 1,
        });
        if (previous && JSON.stringify(previous.units) !== JSON.stringify(result.unavailable_units)) {
            throw new ReadApiError('bad_request', 'Storage availability changed; restart pagination without a cursor');
        }
        const items = result.items.slice(0, limit);
        const last = items[items.length - 1];
        const nextCursor =
            result.items.length > limit && last
                ? encodeSignedCursor({
                      v: 1,
                      mode,
                      source: query.source ?? null,
                      status: query.status ?? null,
                      time: last.receivedAt.toISOString(),
                      id: last.messageId,
                      units: result.unavailable_units,
                  } satisfies Cursor)
                : null;
        return { items, nextCursor, partial: result.partial, unavailable_units: result.unavailable_units };
    }

    private decodeCursor(cursor: string): Cursor {
        try {
            return cursorSchema.parse(decodeSignedCursor(cursor));
        } catch {
            throw new ReadApiError('bad_request', 'Invalid cursor');
        }
    }
}

/** Field set and order exactly as Lampiran A. */
export function toAuditItem(entry: UnprocessedMessage) {
    return {
        message_id: entry.messageId,
        source: entry.source,
        received_at: entry.receivedAt.toISOString(),
        reason: entry.reason,
        retryable: entry.retryable,
        attempts: entry.attempts,
        status: entry.status,
    };
}

function toInspectionItem(entry: UnprocessedMessage) {
    return {
        ...toAuditItem(entry),
        category: entry.category,
        context: entry.context,
        source_ref_id: entry.sourceRefId,
        correlation_id: entry.correlationId,
        last_seen_at: entry.lastSeenAt.toISOString(),
        seen_count: entry.seenCount,
        max_attempts: entry.maxAttempts,
        next_attempt_at: entry.nextAttemptAt?.toISOString() ?? null,
        content_type: entry.contentType,
        size_bytes: entry.sizeBytes,
        sha256: entry.sha256,
        recovered_at: entry.recoveredAt?.toISOString() ?? null,
        recovered_hazard_id: entry.recoveredHazardId,
    };
}
