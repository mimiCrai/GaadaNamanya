export function computeBackoffMs(
    attempt: number,
    baseMs: number,
    capMs: number,
    random: () => number = Math.random
): number {
    const exponent = Math.max(0, attempt - 1);
    const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(exponent, 30));
    const jitter = Math.min(1, Math.max(0, random()));
    return Math.round(ceiling * (0.5 + jitter * 0.5));
}
