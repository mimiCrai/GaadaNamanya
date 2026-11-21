import { RawLogRecord } from '../../src/types/fire';

export interface Det {
    sat?: string;
    date?: string;
    time?: string | number;
    lat: string;
    lon: string;
    conf?: 'l' | 'n' | 'h';
    frp?: string;
}

const RECEIVED_AT = '2026-11-15T12:00:00.000Z';

export function detectionJson(d: Det): string {
    const time = typeof d.time === 'string' ? `"${d.time}"` : String(d.time ?? 300);
    return (
        `{"version":"2.0NRT","acq_date":"${d.date ?? '2026-11-15'}","acq_time":${time},` +
        `"confidence":"${d.conf ?? 'n'}","frp":${d.frp ?? '5.00'},"instrument":"VIIRS",` +
        `"latitude":${d.lat},"longitude":${d.lon},"satellite":"${d.sat ?? 'N20'}"}`
    );
}

export function keyOf(d: Det): string {
    return `${d.sat ?? 'N20'}|${d.date ?? '2026-11-15'}|${d.time ?? 300}|${d.lat}|${d.lon}`;
}

export class LogBuilder {
    readonly records: RawLogRecord[] = [];
    private next = 0;

    detection(d: Det): this {
        return this.push('detection', (offset) => `{"offset":${offset},"detection":${detectionJson(d)}}`);
    }

    update(d: Det): this {
        return this.push('update', (offset) => `{"offset":${offset},"detection":${detectionJson(d)}}`);
    }

    retract(d: Det): this {
        return this.push('retract', (offset) => `{"offset":${offset},"detection_key":"${keyOf(d)}"}`);
    }

    retractByDetection(d: Det): this {
        return this.push('retract', (offset) => `{"offset":${offset},"detection":${detectionJson(d)}}`);
    }

    heartbeat(virtualNow: string): this {
        const offset = this.next++;
        this.records.push({
            v: 1,
            offset,
            kind: 'heartbeat',
            received_at: RECEIVED_AT,
            data_raw: `{"offset":${offset},"virtual_now":"${virtualNow}"}`,
            virtual_now: virtualNow,
        });
        return this;
    }

    unprocessed(): this {
        const offset = this.next++;
        this.records.push({ v: 1, offset, kind: 'unprocessed', received_at: RECEIVED_AT, reason: 'malformed_json: x' });
        return this;
    }

    private push(kind: string, data: (offset: number) => string): this {
        const offset = this.next++;
        this.records.push({ v: 1, offset, kind, received_at: RECEIVED_AT, data_raw: data(offset) });
        return this;
    }
}
