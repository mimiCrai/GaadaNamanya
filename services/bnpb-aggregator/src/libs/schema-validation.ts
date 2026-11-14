import { z, ZodIssue } from 'zod';
import { ProcessingError } from './processing-error';

export function validateRecord<T>(value: unknown, schema: z.ZodType<T>, knownFields: readonly string[]): T {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ProcessingError('schema_incompatible', `record harus berupa objek, diterima ${describe(value)}`);
    }
    const result = schema.safeParse(value);
    if (result.success) return result.data;

    const record = value as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter((key) => !knownFields.includes(key));
    const mapped = result.error.issues.map((issue) => mapIssue(issue, record, unknownKeys));
    const shape = mapped.filter((issue) => issue.category === 'schema_incompatible');
    const chosen = shape.length > 0 ? shape : mapped;
    throw new ProcessingError(
        chosen[0].category,
        chosen
            .slice(0, 3)
            .map((issue) => issue.detail)
            .join('; ')
    );
}

interface MappedIssue {
    category: 'schema_incompatible' | 'validation_failed';
    detail: string;
}

function mapIssue(issue: ZodIssue, record: Record<string, unknown>, unknownKeys: string[]): MappedIssue {
    const path = issue.path.join('.') || 'record';
    if (issue.code === 'invalid_type') {
        if (issue.received === 'undefined') {
            const renamed = unknownKeys.find((key) => sameKind(record[key], issue.expected));
            return {
                category: 'schema_incompatible',
                detail: renamed
                    ? `field wajib '${path}' hilang (kemungkinan di-rename menjadi '${renamed}')`
                    : `field wajib '${path}' hilang`,
            };
        }
        return {
            category: 'schema_incompatible',
            detail: `field '${path}' berubah dari ${issue.expected} menjadi ${issue.received}`,
        };
    }
    if (issue.code === 'invalid_enum_value') {
        return {
            category: 'validation_failed',
            detail: `field '${path}' bernilai ${JSON.stringify(issue.received)} di luar nilai yang dikenal (${issue.options.join('|')})`,
        };
    }
    if (issue.code === 'invalid_string') {
        return {
            category: 'validation_failed',
            detail: `field '${path}' tidak sesuai format ${String(issue.validation)}`,
        };
    }
    if (issue.code === 'too_small' || issue.code === 'too_big') {
        return { category: 'validation_failed', detail: `field '${path}' di luar rentang yang diizinkan` };
    }
    return { category: 'validation_failed', detail: `field '${path}' tidak valid (${issue.message})` };
}

function sameKind(value: unknown, expected: string): boolean {
    if (value === undefined) return false;
    if (expected === 'integer' || expected === 'float') return typeof value === 'number';
    // zod reports a missing enum as e.g. "'Normal' | 'Waspada'": a string-valued field.
    if (expected.startsWith("'")) return typeof value === 'string';
    return describe(value) === expected;
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}
