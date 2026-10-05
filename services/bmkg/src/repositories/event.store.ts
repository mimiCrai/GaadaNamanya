import { injectable } from 'inversify';
import { SeismicEvent, TsunamiWarning } from '../types/contract';

export interface ListQuery {
    since?: Date;
    limit: number;
}

export interface IEventStore {
    addEvents(events: SeismicEvent[]): void;
    addWarnings(warnings: TsunamiWarning[]): void;
    listEvents(query: ListQuery): SeismicEvent[];
    listWarnings(query: ListQuery): TsunamiWarning[];
    hasEvent(eventId: string): boolean;
}

@injectable()
export class EventStore implements IEventStore {
    private readonly events: SeismicEvent[] = [];
    private readonly warnings: TsunamiWarning[] = [];
    private readonly eventIds = new Set<string>();

    addEvents(events: SeismicEvent[]): void {
        for (const event of events) {
            if (this.eventIds.has(event.event_id)) {
                throw new Error(`Duplicate event_id ${event.event_id}`);
            }
            this.eventIds.add(event.event_id);
            insertSorted(this.events, event, (record) => record.occurred_at);
        }
    }

    addWarnings(warnings: TsunamiWarning[]): void {
        for (const warning of warnings) {
            if (!this.eventIds.has(warning.related_event_id)) {
                throw new Error(`Warning ${warning.warning_id} references unknown event ${warning.related_event_id}`);
            }
            insertSorted(this.warnings, warning, (record) => record.issued_at);
        }
    }

    listEvents(query: ListQuery): SeismicEvent[] {
        return filterSince(this.events, query, (record) => record.occurred_at);
    }

    listWarnings(query: ListQuery): TsunamiWarning[] {
        return filterSince(this.warnings, query, (record) => record.issued_at);
    }

    hasEvent(eventId: string): boolean {
        return this.eventIds.has(eventId);
    }
}

function insertSorted<T>(records: T[], record: T, timeOf: (record: T) => string): void {
    const time = Date.parse(timeOf(record));
    let index = records.length;
    while (index > 0 && Date.parse(timeOf(records[index - 1])) > time) {
        index--;
    }
    records.splice(index, 0, record);
}

function filterSince<T>(records: T[], query: ListQuery, timeOf: (record: T) => string): T[] {
    const sinceMs = query.since?.getTime();
    const matching =
        sinceMs === undefined ? records : records.filter((record) => Date.parse(timeOf(record)) >= sinceMs);
    return matching.slice(0, query.limit);
}
