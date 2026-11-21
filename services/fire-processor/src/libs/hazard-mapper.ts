import { CENTROID_SCALE, SEVERITY_LEVELS } from '../constants/fire';
import { Decimal, Detection, Fire, Severity, WildfireHazard } from '../types/fire';
import { compareText, isoSeconds } from '../util/format';
import { compareDecimal, decimalToNumber, divideHalfEven, parseDecimal, sumDecimals } from './decimal';
import { ProvinceIndex } from './province-index';

export function severityOf(detectionCount: number, totalFrp: Decimal): Severity {
    const level = SEVERITY_LEVELS.find(
        ({ minCount, minFrp }) => detectionCount >= minCount || compareDecimal(totalFrp, minFrp) >= 0
    );
    return level?.severity ?? 'WASPADA';
}

// Exact decimal mean of the raw feed text, rounded half-even.
function meanOf(texts: string[]): number {
    const values = texts.map((text) => parseDecimal(text)!);
    return decimalToNumber(divideHalfEven(sumDecimals(values), BigInt(values.length), CENTROID_SCALE));
}

export function mapFire(fire: Fire, members: readonly Detection[], provinces: ProvinceIndex): WildfireHazard {
    const detections = [...members].sort((a, b) => compareText(a.key, b.key));
    const totalFrp = sumDecimals(detections.map((d) => d.frp));
    const latitude = meanOf(detections.map((d) => d.latText));
    const longitude = meanOf(detections.map((d) => d.lonText));
    const firstSeenMs = detections.reduce((min, d) => Math.min(min, d.eventTimeMs), Infinity);
    return {
        source: 'SATELIT',
        source_ref_id: fire.id,
        hazard_type: 'WILDFIRE',
        severity: severityOf(detections.length, totalFrp),
        area_name: provinces.nearest(latitude, longitude),
        latitude,
        longitude,
        occurred_at: isoSeconds(firstSeenMs),
        attributes: {
            detection_count: detections.length,
            satellites: [...new Set(detections.map((d) => d.satellite))].sort(compareText),
            max_confidence: detections.some((d) => d.confidence === 'h') ? 'h' : 'n',
            total_frp_mw: decimalToNumber(totalFrp),
            detection_keys: detections.map((d) => d.key),
        },
    };
}
