// In-memory stand-in for the few CanonicalStore calls the lease-free write paths use (no Mongo needed)
type Doc = Record<string, unknown> & { _id: string };
type Filter = Record<string, unknown>;

// deep copy inside the test realm (structuredClone changes prototypes, which isDeepStrictEqual sees)
function clone<T>(value: T): T {
    if (value instanceof Date) return new Date(value.getTime()) as T;
    if (Array.isArray(value)) return value.map(clone) as T;
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
    }
    return value;
}

function matches(doc: Doc | undefined, filter: Filter): boolean {
    if (!doc) return false;
    return Object.entries(filter).every(([key, condition]) => {
        if (key === '$or') return (condition as Filter[]).some((branch) => matches(doc, branch));
        const value = doc[key];
        if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
            const ops = condition as Record<string, unknown>;
            if ('$exists' in ops) return (value !== undefined) === ops.$exists;
            if ('$lte' in ops) return value !== undefined && (value as string | number) <= (ops.$lte as string | number);
            if ('$in' in ops) return (ops.$in as unknown[]).includes(value);
        }
        return value === condition;
    });
}

export class DuplicateKeyError extends Error {
    code = 11000;
}

export class FakeCollection {
    readonly docs = new Map<string, Doc>();

    async findOne(filter: Filter, options: { projection?: Record<string, 0> } = {}) {
        const doc = [...this.docs.values()].find((candidate) => matches(candidate, filter));
        if (!doc) return null;
        const copy: Record<string, unknown> = clone(doc);
        for (const [field, flag] of Object.entries(options.projection ?? {})) if (flag === 0) delete copy[field];
        return copy;
    }

    async insertOne(doc: Doc) {
        if (this.docs.has(doc._id)) throw new DuplicateKeyError('E11000');
        this.docs.set(doc._id, clone(doc));
        return { insertedId: doc._id };
    }

    async replaceOne(filter: Filter, doc: Record<string, unknown>) {
        const current = this.docs.get(filter._id as string);
        if (!matches(current, filter)) return { matchedCount: 0 };
        this.docs.set(current!._id, { ...clone(doc), _id: current!._id });
        return { matchedCount: 1 };
    }

    async deleteOne(filter: Filter) {
        const current = this.docs.get(filter._id as string);
        if (!matches(current, filter)) return { deletedCount: 0 };
        this.docs.delete(current!._id);
        return { deletedCount: 1 };
    }

    async updateOne(filter: Filter, update: Record<string, Record<string, unknown>>, options: { upsert?: boolean } = {}) {
        const id = filter._id as string;
        let current = this.docs.get(id);
        if (!matches(current, filter)) {
            if (!options.upsert) return { matchedCount: 0 };
            if (current) throw new DuplicateKeyError('E11000');
            current = { _id: id };
        }
        const next: Doc = { ...current, ...clone(update.$set ?? {}), _id: id };
        for (const [field, value] of Object.entries(update.$max ?? {})) {
            const previous = next[field] as string | number | undefined;
            if (previous === undefined || (value as string | number) > previous) next[field] = value;
        }
        this.docs.set(id, next);
        return { matchedCount: 1 };
    }
}

export class FakeCanonicalStore {
    private readonly collections = new Map<string, FakeCollection>();
    readonly client = {
        startSession: () => ({
            withTransaction: async <T>(work: () => Promise<T>) => work(),
            endSession: async () => undefined,
        }),
    };

    collection(name: string): FakeCollection {
        if (!this.collections.has(name)) this.collections.set(name, new FakeCollection());
        return this.collections.get(name)!;
    }
}
