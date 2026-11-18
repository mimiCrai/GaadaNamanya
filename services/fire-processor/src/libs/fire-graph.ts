import { Detection, GraphChange } from '../types/fire';
import { compareText } from '../util/format';
import { cellIndex, cellKey, isLinked, neighborCells } from './geo';

export const isActive = (detection: Detection): boolean => !detection.retracted && detection.confidence !== 'l';

const NO_CHANGE: GraphChange = { before: [], after: [] };
const sorted = (keys: Iterable<string>): string[] => [...keys].sort(compareText);
const byFirst = (a: string[], b: string[]): number => compareText(a[0], b[0]);
const cellOf = (detection: Detection): string => cellKey(cellIndex(detection.lat), cellIndex(detection.lon));

// Connected components of active detections, kept in sync incrementally via a spatial grid.
export class FireGraph {
    private readonly detections = new Map<string, Detection>();
    private readonly grid = new Map<string, Set<string>>();
    private readonly componentOf = new Map<string, number>();
    private readonly components = new Map<number, Set<string>>();
    private nextComponentId = 0;
    private singleCount = 0;
    private lowCount = 0;
    private retractedCount = 0;

    get size(): number {
        return this.detections.size;
    }

    get(key: string): Detection | undefined {
        return this.detections.get(key);
    }

    counts() {
        return {
            detections: this.detections.size,
            active: this.componentOf.size,
            low_excluded: this.lowCount,
            retracted: this.retractedCount,
            single_detections: this.singleCount,
        };
    }

    allSorted(): Detection[] {
        return sorted(this.detections.keys()).map((key) => this.detections.get(key)!);
    }

    componentMembers(key: string): string[] | undefined {
        const id = this.componentOf.get(key);
        return id === undefined ? undefined : sorted(this.components.get(id)!);
    }

    put(next: Detection): GraphChange {
        const previous = this.detections.get(next.key);
        const wasActive = previous !== undefined && isActive(previous);
        const nowActive = isActive(next);
        if (previous) this.count(previous, -1);
        this.count(next, 1);
        this.detections.set(next.key, next);

        if (!wasActive && !nowActive) return NO_CHANGE;
        if (wasActive && nowActive) {
            const members = this.componentMembers(next.key)!;
            return { before: [members], after: [members] };
        }
        return nowActive ? this.activate(next) : this.deactivate(next);
    }

    restore(detections: Iterable<Detection>): void {
        this.detections.clear();
        this.grid.clear();
        this.componentOf.clear();
        this.components.clear();
        this.nextComponentId = 0;
        this.singleCount = this.lowCount = this.retractedCount = 0;
        for (const detection of detections) {
            this.detections.set(detection.key, detection);
            this.count(detection, 1);
            if (isActive(detection)) this.addToGrid(detection);
        }
        this.rebuild(sorted(this.detections.keys()));
    }

    activeNeighbors(detection: Detection): string[] {
        const found: string[] = [];
        for (const cell of neighborCells(detection.lat, detection.lon)) {
            for (const key of this.grid.get(cell) ?? []) {
                if (key !== detection.key && isLinked(detection, this.detections.get(key)!)) found.push(key);
            }
        }
        return found.sort(compareText);
    }

    private activate(next: Detection): GraphChange {
        this.addToGrid(next);
        const ids = new Set(this.activeNeighbors(next).map((key) => this.componentOf.get(key)!));
        const before = [...ids].map((id) => sorted(this.components.get(id)!)).sort(byFirst);
        ids.forEach((id) => this.dropComponent(id));
        return { before, after: this.rebuild([next.key, ...before.flat()]) };
    }

    private deactivate(next: Detection): GraphChange {
        const members = this.componentMembers(next.key)!;
        this.dropComponent(this.componentOf.get(next.key)!);
        this.removeFromGrid(next);
        return { before: [members], after: this.rebuild(members.filter((key) => key !== next.key)) };
    }

    private rebuild(seeds: string[]): string[][] {
        const result: string[][] = [];
        for (const seed of sorted(seeds)) {
            if (this.componentOf.has(seed)) continue;
            const start = this.detections.get(seed);
            if (!start || !isActive(start)) continue;
            result.push(sorted(this.flood(start)));
        }
        return result.sort(byFirst);
    }

    private flood(start: Detection): Set<string> {
        const id = this.nextComponentId++;
        const members = new Set([start.key]);
        this.componentOf.set(start.key, id);
        const queue = [start];
        while (queue.length > 0) {
            for (const key of this.activeNeighbors(queue.pop()!)) {
                if (members.has(key)) continue;
                members.add(key);
                this.componentOf.set(key, id);
                queue.push(this.detections.get(key)!);
            }
        }
        this.components.set(id, members);
        if (members.size === 1) this.singleCount++;
        return members;
    }

    private dropComponent(id: number): void {
        const members = this.components.get(id)!;
        if (members.size === 1) this.singleCount--;
        members.forEach((key) => this.componentOf.delete(key));
        this.components.delete(id);
    }

    private count(detection: Detection, delta: number): void {
        if (detection.retracted) this.retractedCount += delta;
        else if (detection.confidence === 'l') this.lowCount += delta;
    }

    private addToGrid(detection: Detection): void {
        const cell = cellOf(detection);
        const keys = this.grid.get(cell) ?? new Set<string>();
        keys.add(detection.key);
        this.grid.set(cell, keys);
    }

    private removeFromGrid(detection: Detection): void {
        const cell = cellOf(detection);
        const keys = this.grid.get(cell);
        keys?.delete(detection.key);
        if (keys?.size === 0) this.grid.delete(cell);
    }
}
