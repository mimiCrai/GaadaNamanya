import 'reflect-metadata';
import { hazardTombstones } from '../../src/db/schema/fire-processor';
import { HazardSeverity, HazardSource, HazardType, hazardEvents } from '../../src/db/schema/hazard-events';
import { outboxEvents } from '../../src/db/schema/outbox-events';
import { canonicalHazardId } from '../../src/repositories/hazard-event.repository';
import { feedVersion, HazardWriteContent, HazardWriteRepository } from '../../src/repositories/hazard-write.repository';
import { FakeCanonicalStore } from '../helpers/fake-mongo-store';

const ref = 'fire-0a41c7aa1b2c';
const hazardId = canonicalHazardId(HazardSource.Satelit, ref);
const content = (severity = HazardSeverity.Waspada, count = 2): HazardWriteContent => ({
    hazardType: HazardType.Wildfire,
    severity,
    areaName: 'Kalimantan Tengah',
    latitude: -2.51234,
    longitude: 113.8045,
    occurredAt: new Date('2026-11-12T02:43:00Z'),
    attributes: { detection_count: count, satellites: ['N20'], max_confidence: 'h', total_frp_mw: 1.5, detection_keys: [] },
});
const upsert = (version: number, hazard = content()) =>
    ({ op: 'upsert', source: HazardSource.Satelit, sourceRefId: ref, version, hazard }) as const;
const remove = (version: number) => ({ op: 'delete', source: HazardSource.Satelit, sourceRefId: ref, version }) as const;

describe('HazardWriteRepository (usulan 3.4, lease-free, version guard + tombstone)', () => {
    let store: FakeCanonicalStore;
    let repository: HazardWriteRepository;
    const outbox = () => [...store.collection(outboxEvents).docs.values()].map((event) => event.eventType);
    const stored = () => store.collection(hazardEvents).docs.get(hazardId);

    beforeEach(() => {
        store = new FakeCanonicalStore();
        repository = new HazardWriteRepository(store as never);
    });

    it('pads feed offsets so the shared string version compares numerically', () => {
        expect(feedVersion(9) < feedVersion(10)).toBe(true);
        expect(feedVersion(123)).toBe('0000000000000123');
    });

    it('creates, repeats idempotently, updates, and skips an older version', async () => {
        expect((await repository.apply(upsert(5), 'c')).result).toBe('applied');
        expect((await repository.apply(upsert(5), 'c')).result).toBe('unchanged');
        expect((await repository.apply(upsert(9, content(HazardSeverity.Siaga, 6)), 'c')).result).toBe('applied');
        expect((await repository.apply(upsert(7), 'c')).result).toBe('skipped');
        expect(stored()).toMatchObject({ severity: 'SIAGA', version: feedVersion(9), hazardId, source: 'SATELIT' });
        expect(outbox()).toEqual(['hazard.created', 'hazard.updated']);
    });

    it('a replay of the same content at a newer offset only moves the version, without an outbox event', async () => {
        await repository.apply(upsert(5), 'c');
        expect((await repository.apply(upsert(8), 'c')).result).toBe('unchanged');
        expect(stored()?.version).toBe(feedVersion(8));
        expect(outbox()).toEqual(['hazard.created']);
    });

    it('delete removes the document, writes a tombstone and enqueues hazard.deleted with the last state', async () => {
        await repository.apply(upsert(5), 'c');
        expect((await repository.apply(remove(12), 'c')).result).toBe('applied');
        expect(stored()).toBeUndefined();
        expect(store.collection(hazardTombstones).docs.get(hazardId)).toMatchObject({ version: feedVersion(12) });
        const events = [...store.collection(outboxEvents).docs.values()];
        expect(events.map((event) => event.eventType)).toEqual(['hazard.created', 'hazard.deleted']);
        expect(events[1]).toMatchObject({ payload: { eventType: 'hazard.deleted', hazard: { hazardId, sourceRefId: ref } } });
        expect((await repository.apply(remove(12), 'c')).result).toBe('unchanged');
    });

    it('a stale upsert (replayed after a merge) cannot bring a deleted fire back', async () => {
        await repository.apply(upsert(5), 'c');
        await repository.apply(remove(12), 'c');
        expect((await repository.apply(upsert(9), 'c')).result).toBe('skipped');
        expect(stored()).toBeUndefined();
        expect((await repository.apply(upsert(20), 'c')).result).toBe('applied');
        expect(stored()?.version).toBe(feedVersion(20));
    });

    it('a delete older than the stored version is skipped and never lowers the tombstone', async () => {
        await repository.apply(remove(30), 'c');
        await repository.apply(upsert(40), 'c');
        expect((await repository.apply(remove(35), 'c')).result).toBe('skipped');
        expect(stored()?.version).toBe(feedVersion(40));
        expect(store.collection(hazardTombstones).docs.get(hazardId)?.version).toBe(feedVersion(30));
    });

    it('replaying the same op sequence twice gives the same final state and outbox', async () => {
        const ops = [upsert(1), upsert(3, content(HazardSeverity.Siaga, 6)), remove(4), upsert(6)];
        for (const op of ops) await repository.apply(op, 'c');
        const firstState = { ...stored() };
        const firstOutbox = outbox();
        for (const op of ops) await repository.apply(op, 'c');
        expect({ ...stored(), ingestedAt: null }).toEqual({ ...firstState, ingestedAt: null });
        expect(outbox()).toEqual(firstOutbox);
    });
});
