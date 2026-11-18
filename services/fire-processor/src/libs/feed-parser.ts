import { Confidence, DetectionInput, DetectionKeyParts, FeedEvent, RawLogRecord, RawValue } from '../types/fire';
import { parseDecimal } from './decimal';
import { rawObjectMembers, scalarText } from './raw-json';

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_TEXT = /^\d{1,4}$/;
const CONFIDENCES: readonly string[] = ['l', 'n', 'h'];

// acq_time is HHMM without leading zeros ("243" = 02:43), interpreted as UTC.
export function detectionTimeMs(acqDate: string, acqTime: string): number | null {
    const date = DATE_TEXT.exec(acqDate);
    if (!date || !TIME_TEXT.test(acqTime)) return null;
    const padded = acqTime.padStart(4, '0');
    const hours = Number(padded.slice(0, 2));
    const minutes = Number(padded.slice(2));
    if (hours > 23 || minutes > 59) return null;
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const ms = Date.UTC(year, month - 1, day, hours, minutes);
    const check = new Date(ms);
    const sameDay = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
    return sameDay ? ms : null;
}

export const detectionKeyOf = (p: DetectionKeyParts): string =>
    `${p.satellite}|${p.acqDate}|${p.acqTime}|${p.latText}|${p.lonText}`;

function coordinate(text: string | null, limit: number): number {
    const value = text === null || parseDecimal(text) === null ? NaN : Number(text);
    return Math.abs(value) <= limit ? value : NaN;
}

export function parseDetection(members: Map<string, RawValue>): DetectionInput | string {
    const satellite = members.get('satellite');
    if (satellite?.kind !== 'string' || satellite.value === '' || satellite.value.includes('|')) {
        return "field 'satellite' tidak valid";
    }
    const acqDate = members.get('acq_date');
    if (acqDate?.kind !== 'string') return "field 'acq_date' tidak valid";
    const acqTime = scalarText(members.get('acq_time'));
    if (acqTime === null) return "field 'acq_time' tidak valid";
    const eventTimeMs = detectionTimeMs(acqDate.value, acqTime);
    if (eventTimeMs === null) return `waktu deteksi '${acqDate.value} ${acqTime}' tidak valid`;

    const latText = scalarText(members.get('latitude'));
    const lonText = scalarText(members.get('longitude'));
    const lat = coordinate(latText, 90);
    const lon = coordinate(lonText, 180);
    if (Number.isNaN(lat)) return "field 'latitude' tidak valid";
    if (Number.isNaN(lon)) return "field 'longitude' tidak valid";

    const confidence = members.get('confidence');
    if (confidence?.kind !== 'string' || !CONFIDENCES.includes(confidence.value)) {
        return "field 'confidence' tidak valid";
    }
    const frpText = scalarText(members.get('frp'));
    const frp = frpText === null ? null : parseDecimal(frpText);
    if (frpText === null || frp === null || frp.units < 0n) return "field 'frp' tidak valid";

    const parts: DetectionKeyParts = {
        satellite: satellite.value,
        acqDate: acqDate.value,
        acqTime,
        latText: latText!,
        lonText: lonText!,
    };
    return {
        key: detectionKeyOf(parts),
        ...parts,
        lat,
        lon,
        eventTimeMs,
        confidence: confidence.value as Confidence,
        frpText,
        frp,
    };
}

const offsetOf = (record: RawLogRecord): number | null =>
    typeof record.offset === 'number' && Number.isSafeInteger(record.offset) && record.offset >= 0
        ? record.offset
        : null;

function parseHeartbeat(record: RawLogRecord, offset: number): FeedEvent {
    let text = typeof record.virtual_now === 'string' ? record.virtual_now : null;
    if (text === null && typeof record.data_raw === 'string') {
        const virtualNow = rawObjectMembers(record.data_raw)?.get('virtual_now');
        text = virtualNow?.kind === 'string' ? virtualNow.value : null;
    }
    const virtualNowMs = text === null ? NaN : Date.parse(text);
    if (Number.isNaN(virtualNowMs)) return { type: 'invalid', offset, reason: 'heartbeat tanpa virtual_now' };
    return { type: 'heartbeat', offset, virtualNowMs };
}

function parseFeedChange(
    record: RawLogRecord,
    kind: 'detection' | 'update' | 'retract',
    offset: number,
    receivedAt: string | null
): FeedEvent {
    const members = typeof record.data_raw === 'string' ? rawObjectMembers(record.data_raw) : null;
    if (!members) return { type: 'invalid', offset, reason: 'data_raw bukan objek JSON' };
    const nested = members.get('detection');
    const detection = nested?.kind === 'object' ? rawObjectMembers(nested.raw) : null;

    if (kind === 'retract') {
        const key = members.get('detection_key');
        if (key?.kind === 'string' && key.value !== '') return { type: 'retract', offset, receivedAt, key: key.value };
        if (!detection) return { type: 'invalid', offset, reason: 'retract tanpa detection_key/detection' };
        const parsed = parseDetection(detection);
        if (typeof parsed === 'string') return { type: 'invalid', offset, reason: `retract: ${parsed}` };
        return { type: 'retract', offset, receivedAt, key: parsed.key };
    }

    if (!detection) return { type: 'invalid', offset, reason: `${kind} tanpa objek detection` };
    const parsed = parseDetection(detection);
    if (typeof parsed === 'string') return { type: 'invalid', offset, reason: `${kind}: ${parsed}` };
    return { type: kind, offset, receivedAt, detection: parsed };
}

export function parseLogRecord(record: RawLogRecord): FeedEvent {
    const offset = offsetOf(record);
    if (offset === null) return { type: 'invalid', offset: null, reason: 'offset feed tidak valid' };
    const receivedAt = typeof record.received_at === 'string' ? record.received_at : null;

    switch (record.kind) {
        case 'unprocessed':
            return { type: 'unprocessed', offset };
        case 'heartbeat':
            return parseHeartbeat(record, offset);
        case 'detection':
        case 'update':
        case 'retract':
            return parseFeedChange(record, record.kind, offset, receivedAt);
        default:
            return {
                type: 'invalid',
                offset,
                reason: `jenis record '${String(record.kind).slice(0, 32)}' tidak dikenal`,
            };
    }
}
