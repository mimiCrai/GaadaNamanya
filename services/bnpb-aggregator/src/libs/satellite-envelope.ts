import { z } from 'zod';
import { ProcessingError } from './processing-error';
import { decodeJson } from './safe-decode';
import { validateRecord } from './schema-validation';
import type { SseItem } from './sse-parser';

export const SATELLITE_EVENT_KINDS = ['detection', 'update', 'retract', 'heartbeat'] as const;
export type SatelliteEventKind = (typeof SATELLITE_EVENT_KINDS)[number];

export type SseEventItem = Extract<SseItem, { type: 'event' }>;

export type DecodedSatelliteEvent =
    | {
          ok: true;
          offset: number;
          kind: SatelliteEventKind;
          dataText: string;
          virtualNow: string | null;
      }
    | { ok: false; offset: number | null; error: ProcessingError };

const OFFSET_TEXT = /^(0|[1-9][0-9]{0,15})$/;

const envelopeSchema = z.object({ offset: z.number().int().nonnegative() }).passthrough();

const acqTime = z.union([z.number().int().min(0).max(2359), z.string().regex(/^[0-9]{1,4}$/, 'HHMM')]);

const DETECTION_FIELDS = ['satellite', 'acq_date', 'acq_time', 'latitude', 'longitude', 'confidence', 'frp'];
const detectionSchema = z
    .object({
        satellite: z.string().min(1).max(32),
        acq_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
        acq_time: acqTime.refine((value) => Number(value) % 100 < 60, 'menit HHMM harus < 60'),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        confidence: z.enum(['l', 'n', 'h']),
        frp: z.number().nonnegative(),
    })
    .passthrough();

const heartbeatSchema = z
    .object({ offset: z.number(), virtual_now: z.string().datetime({ offset: true }) })
    .passthrough();

export function parseOffsetId(id: string | null): number | null {
    if (id === null || !OFFSET_TEXT.test(id)) return null;
    const value = Number(id);
    return Number.isSafeInteger(value) ? value : null;
}

export function decodeSatelliteEvent(item: SseEventItem, options: { maxDepth: number }): DecodedSatelliteEvent {
    const idOffset = parseOffsetId(item.id);
    let parsed: unknown;
    try {
        parsed = decodeJson(item.data, { maxDepth: options.maxDepth });
    } catch (error) {
        return failure(idOffset, error);
    }

    let dataOffset: number | null = null;
    try {
        const envelope = validateRecord(parsed, envelopeSchema, ['offset']);
        dataOffset = envelope.offset;
        if (idOffset !== null && dataOffset !== idOffset) {
            throw new ProcessingError(
                'validation_failed',
                `offset di data (${dataOffset}) tidak sama dengan id SSE (${idOffset})`
            );
        }
        if (!(SATELLITE_EVENT_KINDS as readonly string[]).includes(item.event)) {
            throw new ProcessingError(
                'validation_failed',
                `jenis event '${item.event.slice(0, 64)}' tidak dikenal (${SATELLITE_EVENT_KINDS.join('|')})`
            );
        }
        const kind = item.event as SatelliteEventKind;
        let virtualNow: string | null = null;
        if (kind === 'detection') {
            const record = envelope as Record<string, unknown>;
            try {
                validateRecord(record.detection, detectionSchema, DETECTION_FIELDS);
            } catch (error) {
                if (!(error instanceof ProcessingError)) throw error;
                throw new ProcessingError(error.category, `detection: ${error.detail}`);
            }
        } else if (kind === 'heartbeat') {
            virtualNow = validateRecord(parsed, heartbeatSchema, ['offset', 'virtual_now']).virtual_now;
        }
        return { ok: true, offset: idOffset ?? dataOffset, kind, dataText: item.data.toString('utf8'), virtualNow };
    } catch (error) {
        return failure(idOffset ?? dataOffset, error);
    }
}

function failure(offset: number | null, error: unknown): DecodedSatelliteEvent {
    if (error instanceof ProcessingError) return { ok: false, offset, error };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, offset, error: new ProcessingError('validation_failed', message) };
}
