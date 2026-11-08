import { inject, injectable } from 'inversify';
import { Long, MaxKey, MinKey, MongoClient } from 'mongodb';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import env from '../util/env';

interface Shard {
    _id: string;
    host: string;
}
export interface StorageTopology {
    shards: Shard[];
    primaries: Record<string, string>;
    unavailable_units: string[];
}
export interface HazardLocation {
    node: string;
    unit: string;
    role: 'primary' | 'replica';
}

export interface IStorageTopologyService {
    inspect(): Promise<StorageTopology>;
    locate(hazardId: string, topology: StorageTopology): Promise<HazardLocation[]>;
    close(): Promise<void>;
}

@injectable()
export class StorageTopologyService implements IStorageTopologyService {
    private cachedShards: Shard[] = [];
    private readonly peers = new Map<string, MongoClient>();
    private inspection: Promise<StorageTopology> | undefined;

    constructor(@inject(TYPES.Database) private readonly store: CanonicalStore) {}

    async inspect(): Promise<StorageTopology> {
        if (!this.inspection) {
            this.inspection = this.inspectShards().finally(() => {
                this.inspection = undefined;
            });
        }
        return this.inspection;
    }

    private async inspectShards(): Promise<StorageTopology> {
        const unavailable = new Set<string>();
        try {
            const result = await this.store.database
                .admin()
                .command({ listShards: 1 }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
            this.cachedShards = result.shards;
        } catch {
            unavailable.add('canonical-metadata');
        }
        const primaries: Record<string, string> = {};
        await Promise.all(
            this.cachedShards.map(async (shard) => {
                try {
                    let client = this.peers.get(shard.host);
                    if (!client) {
                        const [replicaSet, hosts] = shard.host.split('/');
                        client = new MongoClient(`mongodb://${hosts}/?replicaSet=${encodeURIComponent(replicaSet)}`, {
                            serverSelectionTimeoutMS: env.STORAGE_READ_TIMEOUT_MS,
                            connectTimeoutMS: env.STORAGE_READ_TIMEOUT_MS,
                            maxPoolSize: 1,
                        });
                        this.peers.set(shard.host, client);
                    }
                    // hello needs no database credentials and reports the current elected primary.
                    const hello = await client
                        .db('admin')
                        .command({ hello: 1 }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
                    if (!hello.primary) throw new Error('No primary');
                    primaries[shard._id] = hello.primary;
                } catch {
                    unavailable.add(shard._id);
                }
            })
        );
        if (this.cachedShards.length === 0) unavailable.add('canonical-store');
        return { shards: this.cachedShards, primaries, unavailable_units: [...unavailable].sort() };
    }

    async locate(hazardId: string, topology: StorageTopology): Promise<HazardLocation[]> {
        const options = { timeoutMS: env.STORAGE_READ_TIMEOUT_MS };
        const namespace = `${this.store.database.databaseName}.hazard_events`;
        const config = this.store.client.db('config');
        const collection = await config
            .collection<{ _id: string; uuid: unknown }>('collections')
            .findOne({ _id: namespace }, options);
        if (!collection) throw new Error('Collection routing metadata unavailable');
        const result = await this.store.database.command(
            {
                aggregate: 1,
                pipeline: [
                    { $documents: [{ value: hazardId }] },
                    { $project: { hash: { $toHashedIndexKey: '$value' } } },
                ],
                cursor: {},
            },
            options
        );
        const hash = Long.fromValue(result.cursor.firstBatch[0].hash);
        const chunks = await config.collection('chunks').find({ uuid: collection.uuid }, options).toArray();
        const chunk = chunks.find(
            (entry) =>
                (entry.min._id instanceof MinKey || Long.fromValue(entry.min._id).compare(hash) <= 0) &&
                (entry.max._id instanceof MaxKey || Long.fromValue(entry.max._id).compare(hash) > 0)
        );
        const shard = topology.shards.find((entry) => entry._id === chunk?.shard);
        if (!shard) throw new Error('Owning shard unavailable');
        const primary = topology.primaries[shard._id];
        if (!primary) throw new Error('Primary role unknown');
        return shard.host
            .split('/')[1]
            .split(',')
            .map((host) => ({
                node: env.MONGO_NODE_MAP[host] ?? host.split(':')[0],
                unit: `${shard._id}/${host}`,
                role: host === primary ? 'primary' : 'replica',
            }));
    }

    async close(): Promise<void> {
        await Promise.all([...this.peers.values()].map((client) => client.close()));
    }
}
