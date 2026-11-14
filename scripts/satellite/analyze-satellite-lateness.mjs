import { readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'tests/fixtures/satellite';
const session = JSON.parse(readFileSync(path.join(dir, 'session.json'), 'utf8'));
const events = readFileSync(path.join(dir, 'stream-raw.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const speed = Number(session.body.speed);

const anchors = [
    { wall: Date.parse(session.observed_at_wall), virtual: Date.parse(session.body.virtual_now), label: 'session' },
    ...events
        .filter((event) => event.event === 'heartbeat' && event.data?.virtual_now)
        .map((event) => ({ wall: Date.parse(event.received_wall), virtual: Date.parse(event.data.virtual_now), label: `hb#${event.id}` })),
].sort((a, b) => a.wall - b.wall);

function virtualAt(wall) {
    if (wall <= anchors[0].wall) return anchors[0].virtual - (anchors[0].wall - wall) * speed;
    for (let i = 1; i < anchors.length; i++) {
        const a = anchors[i - 1];
        const b = anchors[i];
        if (wall <= b.wall) return a.virtual + ((wall - a.wall) / (b.wall - a.wall)) * (b.virtual - a.virtual);
    }
    const last = anchors[anchors.length - 1];
    return last.virtual + (wall - last.wall) * speed;
}

export function detectionTime(detection) {
    const hhmm = String(detection.acq_time).padStart(4, '0');
    return Date.parse(`${detection.acq_date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
}

const rows = [];
for (const event of events) {
    const detection = event.data?.detection;
    if (!detection) continue;
    const arrival = virtualAt(Date.parse(event.received_wall));
    rows.push({ id: event.id, event: event.event, confidence: detection.confidence, lateness_min: (arrival - detectionTime(detection)) / 60_000 });
}

function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    const round = (value) => Math.round(value * 10) / 10;
    return sorted.length
        ? { n: sorted.length, min: round(sorted[0]), p50: round(pick(0.5)), p95: round(pick(0.95)), p99: round(pick(0.99)), max: round(sorted[sorted.length - 1]) }
        : { n: 0 };
}

// Ketidakpastian pemetaan: drift antar heartbeat dibanding speed nominal.
const drift = anchors.slice(1).map((b, i) => {
    const a = anchors[i];
    return { from: a.label, to: b.label, observed_speed: Math.round(((b.virtual - a.virtual) / (b.wall - a.wall)) * 100) / 100 };
});

const ids = events.map((event) => Number(event.id));
console.log(
    JSON.stringify(
        {
            speed,
            anchors: anchors.map((a) => ({ label: a.label, wall: new Date(a.wall).toISOString(), virtual: new Date(a.virtual).toISOString() })),
            observed_speed_between_anchors: drift,
            offsets: { first: ids[0], last: ids[ids.length - 1], gaps: ids.slice(1).filter((id, i) => id !== ids[i] + 1).length },
            id_equals_data_offset: events.every((event) => String(event.data?.offset) === event.id),
            event_types: events.reduce((acc, event) => ({ ...acc, [event.event]: (acc[event.event] ?? 0) + 1 }), {}),
            lateness_minutes_all: stats(rows.map((row) => row.lateness_min)),
            lateness_minutes_non_low: stats(rows.filter((row) => row.confidence !== 'l').map((row) => row.lateness_min)),
            per_event: rows.map((row) => ({ ...row, lateness_min: Math.round(row.lateness_min * 10) / 10 })),
        },
        null,
        2
    )
);
