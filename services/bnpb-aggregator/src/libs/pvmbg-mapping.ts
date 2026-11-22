import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
    ALERT_LEVELS,
    buildVolcanicReportSchema,
    CORE_REQUIRED_FIELDS,
    DEFAULT_REQUIRED_FIELDS,
    PVMBG_VOLCANIC_FIELDS,
    ValidVolcanicReport,
    VolcanicField,
} from '../clients/pvmbg.schema';
import { findVolcanoLocation, VolcanoLocation } from '../constants/volcano-locations';
import { ProcessingError } from './processing-error';
import { validateRecord } from './schema-validation';

const fieldName = z.enum(PVMBG_VOLCANIC_FIELDS);

const coercionSchema = z.union([
    z.object({ from: z.enum(['number', 'string']), table: z.record(z.string(), z.union([z.string(), z.number()])) }).strict(),
    z.object({ from: z.literal('string'), to: z.enum(['integer', 'number']) }).strict(),
]);

export const mappingFileSchema = z
    .object({
        label: z.string().min(1).max(64).default('unnamed'),
        aliases: z.record(fieldName, z.array(z.string().min(1).max(128)).min(1)).default({}),
        coercions: z.record(fieldName, coercionSchema).default({}),
        required: z.array(fieldName).default([...DEFAULT_REQUIRED_FIELDS]),
    })
    .strict()
    .superRefine((file, ctx) => {
        for (const core of CORE_REQUIRED_FIELDS) {
            if (!file.required.includes(core)) {
                ctx.addIssue({ code: 'custom', path: ['required'], message: `'${core}' harus tetap wajib` });
            }
        }
        const seen = new Set<string>();
        for (const [field, names] of Object.entries(file.aliases)) {
            for (const name of names ?? []) {
                if ((PVMBG_VOLCANIC_FIELDS as readonly string[]).includes(name) || seen.has(name)) {
                    ctx.addIssue({ code: 'custom', path: ['aliases', field], message: `alias '${name}' bentrok` });
                }
                seen.add(name);
            }
        }
        const alertTable = file.coercions.alert_level;
        if (alertTable && 'table' in alertTable) {
            for (const value of Object.values(alertTable.table)) {
                if (!(ALERT_LEVELS as readonly unknown[]).includes(value)) {
                    ctx.addIssue({ code: 'custom', path: ['coercions', 'alert_level'], message: `nilai '${value}' bukan alert_level` });
                }
            }
        }
    });

export type MappingFile = z.infer<typeof mappingFileSchema>;
export type MappingSource = 'builtin' | 'file';

export interface CompiledMapping {
    label: string;
    hash: string;
    source: MappingSource;
    file: MappingFile;
    knownFields: readonly string[];
    schema: ReturnType<typeof buildVolcanicReportSchema>;
}

export interface MappedVolcanicReport {
    report: ValidVolcanicReport;
    attributes: Record<string, unknown>;
    location: VolcanoLocation;
}

export const BUILTIN_MAPPING_FILE: MappingFile = mappingFileSchema.parse({ label: 'builtin-m1' });

export function compileMapping(file: MappingFile, hash: string, source: MappingSource): CompiledMapping {
    const aliasNames = Object.values(file.aliases).flatMap((names) => names ?? []);
    return {
        label: file.label,
        hash,
        source,
        file,
        knownFields: [...PVMBG_VOLCANIC_FIELDS, ...aliasNames],
        schema: buildVolcanicReportSchema(file.required),
    };
}

export const BUILTIN_MAPPING = compileMapping(
    BUILTIN_MAPPING_FILE,
    createHash('sha256').update(JSON.stringify(BUILTIN_MAPPING_FILE)).digest('hex'),
    'builtin'
);

// parses file bytes; throws with a readable message when the file is not a valid mapping
export function parseMappingFile(bytes: Buffer): CompiledMapping {
    const hash = createHash('sha256').update(bytes).digest('hex');
    let json: unknown;
    try {
        json = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new Error(`mapping bukan JSON valid: ${(error as Error).message}`);
    }
    const parsed = mappingFileSchema.safeParse(json);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`);
        throw new Error(`mapping tidak valid: ${detail.join('; ')}`);
    }
    return compileMapping(parsed.data, hash, 'file');
}

/**
 * Pure: aliases → coercions → contract validation (with the mapping's required list) → reference lookup.
 * The same function runs on live polls and on replays from DLQ bytes.
 */
export function mapVolcanicReport(
    value: unknown,
    mapping: CompiledMapping,
    onAliasConflict: (field: string, alias: string) => void = () => undefined
): MappedVolcanicReport {
    const record = isPlainObject(value) ? applyCoercions(applyAliases(value, mapping, onAliasConflict), mapping) : value;
    const report = validateRecord(record, mapping.schema, mapping.knownFields) as unknown as ValidVolcanicReport;
    const { report_id, volcano_id, alert_level, reported_at, ...attributes } = report;
    const location = findVolcanoLocation(volcano_id);
    if (!location) {
        throw new ProcessingError('validation_failed', `volcano_id '${volcano_id}' tidak ada di tabel referensi BNPB`);
    }
    return { report: { report_id, volcano_id, alert_level, reported_at }, attributes, location };
}

function applyAliases(
    record: Record<string, unknown>,
    mapping: CompiledMapping,
    onAliasConflict: (field: string, alias: string) => void
): Record<string, unknown> {
    let entries = Object.entries(record);
    for (const [field, names] of Object.entries(mapping.file.aliases)) {
        for (const alias of names ?? []) {
            if (!(alias in record)) continue;
            if (field in record || entries.some(([key]) => key === field)) {
                // canonical wins; the alias stays as an extra field (attributes)
                onAliasConflict(field, alias);
                continue;
            }
            entries = entries.map(([key, v]) => (key === alias ? [field, v] : [key, v]));
        }
    }
    return Object.fromEntries(entries);
}

function applyCoercions(record: Record<string, unknown>, mapping: CompiledMapping): Record<string, unknown> {
    const out = { ...record };
    for (const [field, rule] of Object.entries(mapping.file.coercions) as [VolcanicField, z.infer<typeof coercionSchema>][]) {
        const current = out[field];
        if (current === undefined || current === null || typeof current !== rule.from) continue;
        if ('table' in rule) {
            const key = String(current);
            if (!Object.prototype.hasOwnProperty.call(rule.table, key)) {
                throw new ProcessingError(
                    'validation_failed',
                    `field '${field}' bernilai ${JSON.stringify(current)} tidak ada di tabel koersi mapping '${mapping.label}'`
                );
            }
            out[field] = rule.table[key];
            continue;
        }
        const text = (current as string).trim();
        const pattern = rule.to === 'integer' ? /^-?\d+$/ : /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
        if (!pattern.test(text)) {
            throw new ProcessingError(
                'validation_failed',
                `field '${field}' bernilai ${JSON.stringify(current)} tidak bisa dikonversi menjadi ${rule.to}`
            );
        }
        out[field] = Number(text);
    }
    return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
