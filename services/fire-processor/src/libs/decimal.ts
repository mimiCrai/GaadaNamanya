import { Decimal } from '../types/fire';

const DECIMAL_TEXT = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/;

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const rescale = (value: Decimal, scale: number): bigint => value.units * pow10(scale - value.scale);
const abs = (n: bigint): bigint => (n < 0n ? -n : n);

export function parseDecimal(text: string): Decimal | null {
    const match = DECIMAL_TEXT.exec(text);
    if (!match) return null;
    const [, sign, integer, fraction = '', exponent = '0'] = match;
    const scale = fraction.length - Number(exponent);
    const digits = integer + fraction + '0'.repeat(Math.max(0, -scale));
    return { units: BigInt(digits) * (sign ? -1n : 1n), scale: Math.max(0, scale) };
}

export function sumDecimals(values: readonly Decimal[]): Decimal {
    const scale = values.reduce((max, value) => Math.max(max, value.scale), 0);
    return { units: values.reduce((sum, value) => sum + rescale(value, scale), 0n), scale };
}

export function compareDecimal(a: Decimal, b: Decimal): number {
    const scale = Math.max(a.scale, b.scale);
    const left = rescale(a, scale);
    const right = rescale(b, scale);
    return left < right ? -1 : left > right ? 1 : 0;
}

export function divideHalfEven(value: Decimal, divisor: bigint, scale: number): Decimal {
    if (divisor <= 0n) throw new RangeError('divisor must be positive');
    const numerator = value.units * pow10(scale);
    const denominator = pow10(value.scale) * divisor;
    let quotient = numerator / denominator;
    const twiceRemainder = abs(numerator % denominator) * 2n;
    if (twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n !== 0n)) {
        quotient += numerator < 0n ? -1n : 1n;
    }
    return { units: quotient, scale };
}

export function formatDecimal(value: Decimal): string {
    const sign = value.units < 0n ? '-' : '';
    const digits = abs(value.units)
        .toString()
        .padStart(value.scale + 1, '0');
    const split = digits.length - value.scale;
    const fraction = value.scale > 0 ? `.${digits.slice(split)}` : '';
    return `${sign}${digits.slice(0, split)}${fraction}`;
}

export const decimalToNumber = (value: Decimal): number => Number(formatDecimal(value));
