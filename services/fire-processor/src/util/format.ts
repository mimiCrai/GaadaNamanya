// Byte-order comparison (not locale-aware) so ordering is deterministic.
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
