import 'reflect-metadata';
import { Binary } from 'mongodb';
import { UnprocessedMessage, UnprocessedStatus } from '../../src/db/schema/unprocessed-messages';
import { ICanonicalReadRepository } from '../../src/repositories/canonical-read.repository';
import { IUnprocessedMessageRepository } from '../../src/repositories/unprocessed-message.repository';
import { CanonicalReadOptions } from '../../src/types/canonical-read';
import { UnprocessedQueryService } from '../../src/services/unprocessed-query.service';

type Doc = UnprocessedMessage & { _id: string };

/** Evaluates the small filter subset the service emits ($and/$or/$in/$gt/equality). */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, condition]) => {
        if (key === '$and') return (condition as Record<string, unknown>[]).every((part) => matches(doc, part));
        if (key === '$or') return (condition as Record<string, unknown>[]).some((part) => matches(doc, part));
        const value = doc[key] as Date | string;
        if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
            const ops = condition as Record<string, unknown>;
            if ('$in' in ops) return (ops.$in as unknown[]).includes(value);
            if ('$gt' in ops) return value > (ops.$gt as Date | string);
        }
        return condition instanceof Date ? (value as Date).getTime() === condition.getTime() : value === condition;
    });
}

class FakeReader implements ICanonicalReadRepository {
    docs: Doc[] = [];
    unavailable: string[] = [];
    lastOptions?: CanonicalReadOptions;
    async read<T>(options: CanonicalReadOptions) {
        this.lastOptions = options;
        const items = this.docs
            .filter((doc) => matches(doc as never, options.filter ?? {}))
            .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || (a._id < b._id ? -1 : 1))
            .slice(0, options.limit);
        return {
            items: items as unknown as T[],
            partial: this.unavailable.length > 0,
            unavailable_units: this.unavailable,
        };
    }
}

function doc(i: number, status: UnprocessedStatus, source = 'PVMBG'): Doc {
    const id = `msg-${i.toString(16).padStart(24, '0')}`;
    return {
        _id: id,
        messageId: id,
        source,
        context: { kind: 'poll.volcanic-report', endpoint: 'GET /volcanic-reports', topic: null },
        // Several entries share a timestamp so the _id tie-breaker is exercised.
        receivedAt: new Date(Date.UTC(2026, 10, 12, 2, 40, Math.floor(i / 3))),
        lastSeenAt: new Date(Date.UTC(2026, 10, 12, 3)),
        seenCount: 2,
        reason: "schema_incompatible: field 'level' berubah dari number menjadi string",
        category: 'schema_incompatible',
        retryable: false,
        attempts: 3,
        maxAttempts: 5,
        status,
        nextAttemptAt: null,
        claimedBy: null,
        claimEpoch: null,
        claimedUntil: null,
        payload: new Binary(Buffer.from([0x7b, 0xff, 0x7d])),
        payloadRef: null,
        contentType: 'application/json',
        sizeBytes: 3,
        sha256: 'ab'.repeat(32),
        correlationId: 'corr',
        sourceRefId: `r-${i}`,
        recoveredAt: null,
        recoveredHazardId: null,
        history: [{ at: new Date(Date.UTC(2026, 10, 12, 2, 40)), attempt: 1, reason: 'x', retryable: false }],
    };
}

describe('UnprocessedQueryService', () => {
    const reader = new FakeReader();
    const repository = {
        findById: jest.fn(),
        readPayload: jest.fn(),
    } as unknown as jest.Mocked<IUnprocessedMessageRepository>;
    const service = new UnprocessedQueryService(reader, repository);

    beforeEach(() => {
        reader.unavailable = [];
        reader.docs = [];
        for (let i = 0; i < 250; i++) reader.docs.push(doc(i, i % 5 === 0 ? 'retrying' : 'parked'));
        for (let i = 250; i < 260; i++) reader.docs.push(doc(i, 'recovered'));
        for (let i = 260; i < 265; i++) reader.docs.push(doc(i, 'parked', 'SATELIT'));
    });

    it('returns Lampiran A items in exact field order, excluding recovered entries', async () => {
        const page = await service.audit({ source: 'PVMBG' });
        expect(Object.keys(page)).toEqual(['items', 'next_cursor', 'partial', 'unavailable_units']);
        const items = page.items as Record<string, unknown>[];
        expect(items).toHaveLength(100); // default limit
        expect(Object.keys(items[0])).toEqual([
            'message_id',
            'source',
            'received_at',
            'reason',
            'retryable',
            'attempts',
            'status',
        ]);
        expect(items[0]).toEqual({
            message_id: 'msg-000000000000000000000000',
            source: 'PVMBG',
            received_at: '2026-11-12T02:40:00.000Z',
            reason: "schema_incompatible: field 'level' berubah dari number menjadi string",
            retryable: false,
            attempts: 3,
            status: 'retrying',
        });
        expect(reader.lastOptions?.projection).toEqual({ _id: 0, payload: 0, history: 0 });
    });

    it('paginates 250 open entries into 100/100/50 and ends with next_cursor null', async () => {
        const seen: string[] = [];
        let cursor: string | undefined;
        const sizes: number[] = [];
        do {
            const page = await service.audit({ source: 'PVMBG', limit: 100, cursor });
            const items = page.items as { message_id: string; status: string }[];
            sizes.push(items.length);
            seen.push(...items.map((item) => item.message_id));
            expect(items.every((item) => item.status !== 'recovered')).toBe(true);
            cursor = (page.next_cursor as string | null) ?? undefined;
        } while (cursor);
        expect(sizes).toEqual([100, 100, 50]);
        expect(new Set(seen).size).toBe(250);
        expect(seen).toEqual([...seen].sort());
    });

    it('filters by source and rejects cursors from another query or tampered cursors', async () => {
        const satellite = await service.audit({ source: 'SATELIT' });
        expect((satellite.items as unknown[]).length).toBe(5);
        const first = await service.audit({ source: 'PVMBG', limit: 10 });
        await expect(service.audit({ source: 'SATELIT', cursor: first.next_cursor as string })).rejects.toMatchObject({
            status: 400,
        });
        await expect(service.list({ source: 'PVMBG', cursor: first.next_cursor as string })).rejects.toMatchObject({
            status: 400,
        });
        await expect(service.audit({ cursor: `${first.next_cursor}x` })).rejects.toMatchObject({ code: 'bad_request' });
    });

    it('reports partial results with unavailable units instead of failing', async () => {
        reader.unavailable = ['canonical-shard-b'];
        const page = await service.audit({});
        expect(page.partial).toBe(true);
        expect(page.unavailable_units).toEqual(['canonical-shard-b']);
    });

    it('lets Internal Ops list recovered entries explicitly and see payload bytes as base64', async () => {
        const recovered = await service.list({ status: 'recovered' });
        expect((recovered.items as unknown[]).length).toBe(10);

        const entry = reader.docs[0];
        repository.findById.mockResolvedValue(entry);
        repository.readPayload.mockResolvedValue(Buffer.from([0x7b, 0xff, 0x7d]));
        const detail = await service.detail(entry.messageId);
        expect(detail).toMatchObject({
            message_id: entry.messageId,
            payload_base64: Buffer.from([0x7b, 0xff, 0x7d]).toString('base64'),
            payload_truncated: false,
            payload_storage: 'inline',
            sha256: entry.sha256,
            raw_url: `/internal/dlq/${entry.messageId}/raw`,
        });
    });
});
