const signature = (item) =>
    JSON.stringify([
        item.station_id,
        item.observed_at,
        item.sea_level_anomaly_m,
        item.wave_height_m,
        item.quality,
        item.critical,
    ]);
const p95 = (values) => (values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null);

export class Measurement {
    known = new Map();
    expected = new Map();
    hazards = new Map();
    inbox = new Map();
    issues = new Set();
    errors = {};
    healthy = { sensor: null, audit: null, notification: null };
    previousSourceStart = null;
    previousGeneratedAt = null;
    previousInboxStart = null;
    previousIds = new Set();
    historicalCount = 0;
    baselineStart = null;
    latestSourceKey = null;

    source(
        items,
        {
            start,
            end,
            generatedAt = null,
            behindSourceClock = false,
            incremental = false,
            advance = true,
            availabilityLower,
        },
        baseline = false
    ) {
        if (behindSourceClock) this.issues.add('source_data_behind_clock');
        if (generatedAt !== null && this.previousGeneratedAt !== null && generatedAt < this.previousGeneratedAt) {
            this.issues.add('source_clock_regressed');
        }
        const ids = new Set(items.map((item) => item.observation_id));
        if (!baseline && !incremental && [...this.previousIds].some((id) => !ids.has(id)))
            this.issues.add('source_history_regressed');
        const priorKey = this.latestSourceKey;
        for (const item of items) {
            const id = item.observation_id;
            const prior = this.known.get(id);
            const next = signature(item);
            if (prior !== undefined && prior !== next) this.issues.add('source_id_changed');
            const key = `${new Date(item.observed_at).toISOString()}|${id}`;
            if (incremental && advance && !baseline && prior === undefined && priorKey && key < priorKey) {
                this.issues.add('source_out_of_order_arrival');
            }
            if (!baseline && prior === undefined && item.critical === true) {
                this.expected.set(id, { sourceLower: availabilityLower ?? this.previousSourceStart, sourceUpper: end });
            }
            this.known.set(id, next);
            if (!this.latestSourceKey || key > this.latestSourceKey) this.latestSourceKey = key;
        }
        if (baseline) {
            this.historicalCount = this.known.size;
            this.baselineStart ??= start;
        }
        if (!incremental) this.previousIds = ids;
        if (
            advance &&
            (baseline ||
                generatedAt === null ||
                this.previousGeneratedAt === null ||
                generatedAt > this.previousGeneratedAt)
        ) {
            this.previousSourceStart = start;
        }
        if (generatedAt !== null)
            this.previousGeneratedAt = Math.max(this.previousGeneratedAt ?? -Infinity, generatedAt);
    }

    verifySource(items, frame, knownAtStart) {
        const ids = new Set(items.map((item) => item.observation_id));
        if ([...knownAtStart].some((id) => !ids.has(id))) this.issues.add('source_history_regressed');
        if (items.some((item) => !this.known.has(item.observation_id))) this.issues.add('source_cursor_missed_event');
        this.source(items, {
            ...frame,
            generatedAt: null,
            incremental: true,
            advance: false,
            availabilityLower: this.baselineStart,
        });
    }

    audit(items) {
        for (const item of items) {
            const old = this.hazards.get(item.source_ref_id);
            if (old && old !== item.hazard_id) this.issues.add('canonical_id_changed');
            this.hazards.set(item.source_ref_id, item.hazard_id);
        }
    }

    notifications(items, { start, end }) {
        for (const item of items) {
            if (!this.inbox.has(item.hazardId)) {
                this.inbox.set(item.hazardId, { lower: this.previousInboxStart, upper: end });
            }
        }
        this.previousInboxStart = start;
    }

    failure(endpoint, reason) {
        this.healthy[endpoint] = false;
        const key = `${endpoint}: ${reason}`;
        this.errors[key] = (this.errors[key] ?? 0) + 1;
    }

    report() {
        const samples = [...this.expected].map(([observationId, source]) => {
            const hazardId = this.hazards.get(observationId) ?? null;
            const received = this.inbox.get(hazardId);
            const sample = { observationId, hazardId, delivered: Boolean(received), lowerMs: null, upperMs: null };
            if (received) {
                const upper = received.upper - source.sourceLower;
                if (upper < 0 || source.sourceLower === null) this.issues.add('inconsistent_availability_interval');
                else {
                    sample.lowerMs = Math.max(0, (received.lower ?? 0) - source.sourceUpper);
                    sample.upperMs = upper;
                    if (sample.lowerMs > upper) this.issues.add('inconsistent_availability_interval');
                }
            }
            return sample;
        });
        const total = samples.length;
        const delivered = samples.filter((s) => s.delivered).length;
        const timed = samples.filter((s) => s.upperMs !== null && s.lowerMs <= s.upperMs);
        const complete = Object.values(this.healthy).every(Boolean) && this.issues.size === 0;
        const lowerP95 = timed.length === total ? p95(timed.map((s) => s.lowerMs)) : null;
        const upperP95 = timed.length === total ? p95(timed.map((s) => s.upperMs)) : null;
        const definitelyLate = timed.filter((s) => s.lowerMs > 5000).length;
        const possiblyLate = total - timed.filter((s) => s.upperMs <= 5000).length;
        const allowedLate = Math.floor(total * 0.05 + 1e-9);
        let status = 'inconclusive';
        if (total > 0 && complete) {
            if (delivered < total || lowerP95 > 5000) status = 'fail';
            else if (upperP95 !== null && upperP95 <= 5000) status = 'pass';
        }
        return {
            status,
            scope: 'New valid critical observation IDs absent from the baseline and exposed by source scans during collection; receiver is the notification inbox.',
            timing: 'Availability-to-inbox observation bounds from one monotonic observer clock. No source, MongoDB, PostgreSQL or node wall-clock subtraction.',
            assumptions:
                'Source cursors preserve position for appended observations, with consistent retained history and stable IDs. A final full scan checks for cursor omissions; detected out-of-order arrivals or omissions prevent certification. Events the source never exposes cannot be counted.',
            target: { deliveryRatio: 1, onTimeRatio: 0.95, deadlineMs: 5000 },
            historicalExcluded: this.historicalCount,
            newObservationIds: this.known.size - this.historicalCount,
            criticalExpected: total,
            delivered,
            missingAfterDrain: total - delivered,
            invalidTimingSamples: delivered - timed.length,
            p95Ms: { lower: lowerP95, upper: upperP95 },
            errorBudget: {
                lossAllowed: 0,
                lossObserved: total - delivered,
                lateAllowed: allowedLate,
                lateDefinitely: definitelyLate,
                latePossibly: possiblyLate,
                lateStatus: !total
                    ? 'not_measured'
                    : !complete
                      ? 'uncertain'
                      : definitelyLate > allowedLate
                        ? 'exceeded'
                        : possiblyLate <= allowedLate
                          ? 'within'
                          : 'uncertain',
                lateRemaining: { minimum: allowedLate - possiblyLate, maximum: allowedLate - definitelyLate },
            },
            issues: [...this.issues],
            lastEndpointReadHealthy: { ...this.healthy },
            observerErrors: { ...this.errors },
            samples,
        };
    }
}
