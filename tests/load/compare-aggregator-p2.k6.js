import { Gauge } from 'k6/metrics';

const baseline = JSON.parse(open(__ENV.BASELINE_SUMMARY));
const scaled = JSON.parse(open(__ENV.SCALED_SUMMARY));
const ratio = new Gauge('throughput_ratio');
const minimum = Number(__ENV.MIN_THROUGHPUT_RATIO || 2);

if (!baseline.passed || !scaled.passed) throw new Error('Both benchmark runs must pass their thresholds');
for (const field of ['target', 'vus', 'durationSeconds', 'path', 'strict', 'iterationSleepSeconds', 'bodySampleEvery', 'requestTimeout']) {
    if (baseline[field] !== scaled[field]) throw new Error(`Benchmark workload differs: ${field}`);
}
const baselineRps = baseline.successfulReads.rate;
const scaledRps = scaled.successfulReads.rate;
if (!(baselineRps > 0) || !(scaledRps > 0)) throw new Error('Both runs need successful HTTP 200 throughput');

export const options = { vus: 1, iterations: 1, thresholds: { throughput_ratio: [`value>=${minimum}`] } };

export default function () {
    ratio.add(scaledRps / baselineRps);
}

export function handleSummary() {
    const result = { baselineRps, scaledRps, ratio: scaledRps / baselineRps, minimum, passed: scaledRps / baselineRps >= minimum };
    return {
        [__ENV.COMPARISON_PATH]: JSON.stringify(result, null, 2),
        stdout: JSON.stringify(result, null, 2) + '\n',
    };
}
