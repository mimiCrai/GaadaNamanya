import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from './metrics';

export const admissionActive = new Gauge({
    name: 'bnpb_admission_active',
    help: 'Active hazard work by priority pool',
    labelNames: ['pool'],
    registers: [metricsRegistry],
});
export const admissionLimit = new Gauge({
    name: 'bnpb_admission_limit',
    help: 'Configured hazard capacity per process',
    labelNames: ['pool'],
    registers: [metricsRegistry],
});
export const admissionRejected = new Counter({
    name: 'bnpb_admission_rejected_total',
    help: 'Controlled hazard rejections before calling Aggregator',
    labelNames: ['role'],
    registers: [metricsRegistry],
});
