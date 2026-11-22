import { hazardEventMessageSchema } from '../../src/contracts/hazard-event-message';

// P4: WILDFIRE events from the fire processor, including hazard.deleted, must not become poison pills
const wildfire = (eventType: string) => ({
    eventId: '11111111-1111-4111-8111-111111111111',
    eventType,
    correlationId: '22222222-2222-4222-8222-222222222222',
    hazard: {
        hazardId: '33333333-3333-4333-8333-333333333333',
        source: 'SATELIT',
        sourceRefId: 'fire-0a41c7aa1b2c',
        hazardType: 'WILDFIRE',
        severity: 'SIAGA',
        areaName: 'Kalimantan Tengah',
        latitude: -2.51234,
        longitude: 113.8045,
        occurredAt: '2026-11-12T02:43:00.000Z',
        ingestedAt: '2026-11-12T02:51:08.000Z',
        attributes: { detection_count: 6, satellites: ['N20', 'N21'] },
    },
});

describe('hazard event contract (P4)', () => {
    it.each(['hazard.created', 'hazard.updated', 'hazard.deleted'])('accepts a SATELIT WILDFIRE %s event', (eventType) => {
        expect(hazardEventMessageSchema.parse(wildfire(eventType)).eventType).toBe(eventType);
    });

    it('still rejects an unknown event type', () => {
        expect(() => hazardEventMessageSchema.parse(wildfire('hazard.exploded'))).toThrow();
    });
});
