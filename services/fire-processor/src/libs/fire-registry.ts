import { createHash } from 'node:crypto';
import { MIN_FIRE_SIZE } from '../constants/fire';
import { Fire, FireChange, FireDeleteReason, GraphChange, StoredFire } from '../types/fire';
import { compareText } from '../util/format';

export const fireIdFor = (anchorKey: string): string =>
    `fire-${createHash('sha256').update(anchorKey, 'utf8').digest('hex').slice(0, 12)}`;

const byId = (a: FireChange, b: FireChange): number => compareText(a.id, b.id);

// Maps graph components to stable fire identities (frozen anchor, merge keeps the earliest anchor).
export class FireRegistry {
    private readonly fires = new Map<string, Fire>();
    private readonly fireOfKey = new Map<string, string>();

    constructor(private readonly timeOf: (key: string) => number) {}

    get size(): number {
        return this.fires.size;
    }

    get(id: string): Fire | undefined {
        return this.fires.get(id);
    }

    fireOf(key: string): string | undefined {
        return this.fireOfKey.get(key);
    }

    allSorted(): Fire[] {
        return [...this.fires.keys()].sort(compareText).map((id) => this.fires.get(id)!);
    }

    countFinal(watermarkMs: number, windowMs: number): number {
        let count = 0;
        for (const fire of this.fires.values()) if (watermarkMs > fire.maxEventTimeMs + windowMs) count++;
        return count;
    }

    apply(change: GraphChange, offset: number): FireChange[] {
        const involved = this.detachInvolved(change.before);
        const componentOf = new Map<string, number>();
        change.after.forEach((members, index) => members.forEach((key) => componentOf.set(key, index)));
        const isFireSized = (index: number | undefined): index is number =>
            index !== undefined && change.after[index].length >= MIN_FIRE_SIZE;

        const deletes: FireChange[] = [];
        const upserts: FireChange[] = [];
        const remove = (fire: Fire, reason: FireDeleteReason) => {
            this.fires.delete(fire.id);
            deletes.push({ op: 'delete', id: fire.id, version: offset, reason });
        };

        const heirs = change.after.map((): Fire[] => []);
        for (const fire of involved) {
            const target = isFireSized(componentOf.get(fire.anchorKey))
                ? componentOf.get(fire.anchorKey)
                : fire.members
                      .filter((key) => isFireSized(componentOf.get(key)))
                      .sort((a, b) => this.byDetection(a, b))
                      .map((key) => componentOf.get(key))[0];
            if (target === undefined) remove(fire, 'dissolved');
            else heirs[target].push(fire);
        }

        const unclaimed: string[][] = [];
        change.after.forEach((members, index) => {
            if (members.length < MIN_FIRE_SIZE) return;
            const [survivor, ...merged] = heirs[index];
            merged.forEach((fire) => remove(fire, 'merged'));
            if (survivor) this.assign(survivor, members, offset, upserts);
            else unclaimed.push(members);
        });
        for (const members of unclaimed) this.create(members, offset, upserts);

        return [...deletes.sort(byId), ...upserts.sort(byId)];
    }

    snapshot(): StoredFire[] {
        return this.allSorted().map((fire) => ({
            id: fire.id,
            anchor_key: fire.anchorKey,
            members: [...fire.members],
            version: fire.version,
        }));
    }

    restore(stored: StoredFire[]): void {
        this.fires.clear();
        this.fireOfKey.clear();
        for (const entry of stored) {
            const fire: Fire = {
                id: entry.id,
                anchorKey: entry.anchor_key,
                members: [],
                version: entry.version,
                maxEventTimeMs: 0,
            };
            this.fires.set(fire.id, fire);
            this.setMembers(fire, entry.members);
        }
    }

    private detachInvolved(before: string[][]): Fire[] {
        const ids = new Set<string>();
        for (const key of before.flat()) {
            const id = this.fireOfKey.get(key);
            if (id !== undefined) ids.add(id);
        }
        const involved = [...ids]
            .map((id) => this.fires.get(id)!)
            .sort((a, b) => this.byDetection(a.anchorKey, b.anchorKey));
        involved.forEach((fire) => fire.members.forEach((key) => this.fireOfKey.delete(key)));
        return involved;
    }

    // New fires take the earliest member whose id is not taken; fall back to hashing all members.
    private create(members: string[], offset: number, upserts: FireChange[]): void {
        const ordered = [...members].sort((a, b) => this.byDetection(a, b));
        const free = ordered.find((key) => !this.fires.has(fireIdFor(key)));
        const fire: Fire = {
            id: fireIdFor(free ?? ordered.join(',')),
            anchorKey: free ?? ordered[0],
            members: [],
            version: offset,
            maxEventTimeMs: 0,
        };
        this.fires.set(fire.id, fire);
        this.assign(fire, members, offset, upserts);
    }

    private assign(fire: Fire, members: string[], offset: number, upserts: FireChange[]): void {
        this.setMembers(fire, members);
        fire.version = offset;
        upserts.push({ op: 'upsert', id: fire.id, version: offset });
    }

    private setMembers(fire: Fire, members: string[]): void {
        fire.members = [...members].sort(compareText);
        fire.maxEventTimeMs = fire.members.reduce((max, key) => Math.max(max, this.timeOf(key)), -Infinity);
        fire.members.forEach((key) => this.fireOfKey.set(key, fire.id));
    }

    private byDetection(a: string, b: string): number {
        return this.timeOf(a) - this.timeOf(b) || compareText(a, b);
    }
}
