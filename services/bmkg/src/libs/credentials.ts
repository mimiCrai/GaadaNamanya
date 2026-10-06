import { createHash, timingSafeEqual } from 'crypto';

function sha256(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}

export function matchesAny(candidate: string, validValues: readonly string[]): boolean {
    const candidateDigest = sha256(candidate);
    let matched = false;
    for (const value of validValues) {
        if (timingSafeEqual(candidateDigest, sha256(value))) {
            matched = true;
        }
    }
    return matched;
}
