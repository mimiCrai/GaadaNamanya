import { RawValue } from '../types/fire';

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const SCALAR_END = new Set([',', '}', ']', ...WHITESPACE]);

function skipWhitespace(text: string, i: number): number {
    while (i < text.length && WHITESPACE.has(text[i])) i++;
    return i;
}

function scanString(text: string, start: number): number {
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') return i + 1;
    }
    throw new SyntaxError('unterminated string');
}

function scanContainer(text: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            i = scanString(text, i);
            continue;
        }
        if (c === '{' || c === '[') depth++;
        else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
        i++;
    }
    throw new SyntaxError('unterminated container');
}

function scanScalar(text: string, start: number): number {
    let end = start;
    while (end < text.length && !SCALAR_END.has(text[end])) end++;
    if (end === start) throw new SyntaxError('missing value');
    return end;
}

function scanValue(text: string, start: number): number {
    const first = text[start];
    if (first === '"') return scanString(text, start);
    if (first === '{' || first === '[') return scanContainer(text, start);
    return scanScalar(text, start);
}

function classify(raw: string): RawValue {
    const first = raw[0];
    if (first === '"') return { kind: 'string', value: JSON.parse(raw) as string, raw };
    if (first === '{') return { kind: 'object', raw };
    if (first === '[') return { kind: 'array', raw };
    if (first === '-' || (first >= '0' && first <= '9')) return { kind: 'number', raw };
    return { kind: 'literal', raw };
}

// Top-level object members with their raw source text, so numbers keep the feed's exact formatting.
export function rawObjectMembers(text: string): Map<string, RawValue> | null {
    try {
        JSON.parse(text);
        let i = skipWhitespace(text, 0);
        if (text[i] !== '{') return null;
        const members = new Map<string, RawValue>();
        i = skipWhitespace(text, i + 1);
        if (text[i] === '}') return members;
        for (;;) {
            if (text[i] !== '"') return null;
            const keyEnd = scanString(text, i);
            const key = JSON.parse(text.slice(i, keyEnd)) as string;
            i = skipWhitespace(text, keyEnd);
            if (text[i] !== ':') return null;
            i = skipWhitespace(text, i + 1);
            const valueEnd = scanValue(text, i);
            members.set(key, classify(text.slice(i, valueEnd)));
            i = skipWhitespace(text, valueEnd);
            if (text[i] !== ',') return text[i] === '}' ? members : null;
            i = skipWhitespace(text, i + 1);
        }
    } catch {
        return null;
    }
}

export function scalarText(value: RawValue | undefined): string | null {
    if (value?.kind === 'string') return value.value;
    if (value?.kind === 'number') return value.raw;
    return null;
}
