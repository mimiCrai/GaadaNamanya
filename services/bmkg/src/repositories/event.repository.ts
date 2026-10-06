import { asc, count, gte } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { Database } from '../db';
import {
    NewSeismicEventRow,
    NewTsunamiWarningRow,
    SeismicEventRow,
    seismicEvents,
    TsunamiWarningRow,
    tsunamiWarnings,
} from '../db/schema';
import { SeismicEvent, TsunamiWarning } from '../types/contract';

export interface ListQuery {
    since?: Date;
    limit: number;
}

export interface IEventRepository {
    insertEvents(events: SeismicEvent[]): Promise<number>;
    insertWarnings(warnings: TsunamiWarning[]): Promise<void>;
    insertEventsWithWarnings(events: SeismicEvent[], warnings: TsunamiWarning[]): Promise<void>;
    listEvents(query: ListQuery): Promise<SeismicEvent[]>;
    listWarnings(query: ListQuery): Promise<TsunamiWarning[]>;
    countEvents(): Promise<number>;
}

@injectable()
export class EventRepository implements IEventRepository {
    constructor(@inject(TYPES.Database) private readonly db: Database) {}

    async insertEvents(events: SeismicEvent[]): Promise<number> {
        if (events.length === 0) return 0;
        const inserted = await this.db
            .insert(seismicEvents)
            .values(events.map(toEventRow))
            .onConflictDoNothing({ target: seismicEvents.eventId })
            .returning({ eventId: seismicEvents.eventId });
        return inserted.length;
    }

    async insertWarnings(warnings: TsunamiWarning[]): Promise<void> {
        if (warnings.length === 0) return;
        await this.db.insert(tsunamiWarnings).values(warnings.map(toWarningRow));
    }

    async insertEventsWithWarnings(events: SeismicEvent[], warnings: TsunamiWarning[]): Promise<void> {
        await this.db.transaction(async (tx) => {
            if (events.length > 0) await tx.insert(seismicEvents).values(events.map(toEventRow));
            if (warnings.length > 0) await tx.insert(tsunamiWarnings).values(warnings.map(toWarningRow));
        });
    }

    async listEvents(query: ListQuery): Promise<SeismicEvent[]> {
        const rows = await this.db
            .select()
            .from(seismicEvents)
            .where(query.since === undefined ? undefined : gte(seismicEvents.occurredAt, query.since))
            .orderBy(asc(seismicEvents.occurredAt), asc(seismicEvents.eventId))
            .limit(query.limit);
        return rows.map(toEvent);
    }

    async listWarnings(query: ListQuery): Promise<TsunamiWarning[]> {
        const rows = await this.db
            .select()
            .from(tsunamiWarnings)
            .where(query.since === undefined ? undefined : gte(tsunamiWarnings.issuedAt, query.since))
            .orderBy(asc(tsunamiWarnings.issuedAt), asc(tsunamiWarnings.warningId))
            .limit(query.limit);
        return rows.map(toWarning);
    }

    async countEvents(): Promise<number> {
        const [{ value }] = await this.db.select({ value: count() }).from(seismicEvents);
        return value;
    }
}

function toEventRow(event: SeismicEvent): NewSeismicEventRow {
    return {
        eventId: event.event_id,
        magnitude: event.magnitude,
        depthKm: event.depth_km,
        epicenterLat: event.epicenter_lat,
        epicenterLon: event.epicenter_lon,
        regionName: event.region_name,
        occurredAt: new Date(event.occurred_at),
        potentialTsunami: event.potential_tsunami,
    };
}

function toEvent(row: SeismicEventRow): SeismicEvent {
    return {
        event_id: row.eventId,
        magnitude: row.magnitude,
        depth_km: row.depthKm,
        epicenter_lat: row.epicenterLat,
        epicenter_lon: row.epicenterLon,
        region_name: row.regionName,
        occurred_at: row.occurredAt.toISOString(),
        potential_tsunami: row.potentialTsunami,
    };
}

function toWarningRow(warning: TsunamiWarning): NewTsunamiWarningRow {
    return {
        warningId: warning.warning_id,
        relatedEventId: warning.related_event_id,
        threatLevel: warning.threat_level,
        affectedZones: warning.affected_zones,
        estimatedArrival: new Date(warning.estimated_arrival),
        issuedAt: new Date(warning.issued_at),
    };
}

function toWarning(row: TsunamiWarningRow): TsunamiWarning {
    return {
        warning_id: row.warningId,
        related_event_id: row.relatedEventId,
        threat_level: row.threatLevel,
        affected_zones: row.affectedZones,
        estimated_arrival: row.estimatedArrival.toISOString(),
        issued_at: row.issuedAt.toISOString(),
    };
}
