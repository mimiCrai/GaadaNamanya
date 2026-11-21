import { inject, injectable } from 'inversify';
import { Long, MaxKey, MinKey, MongoClient, ReadPreference } from 'mongodb';
import { readFileSync } from 'node:fs';
import { get } from 'node:https';
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
    degraded_units?: string[];
    members?: Record<string, { name: string; health: number; state: number }[]>;
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
        const members: NonNullable<StorageTopology['members']> = {};
        const degraded = new Set<string>();
        await Promise.all(
            this.cachedShards.map(async (shard) => {
                try {
                    let client = this.peers.get(shard.host);
                    if (!client) {
                        const [replicaSet, hosts] = shard.host.split('/');
                        const uri = new URL(env.DATABASE_URL);
                        const credentials = uri.username ? `${uri.username}:${uri.password}@` : '';
                        const authSource = uri.searchParams.get('authSource') ?? this.store.database.databaseName;
                        client = new MongoClient(
                            `mongodb://${credentials}${hosts}/?replicaSet=${encodeURIComponent(replicaSet)}&authSource=${encodeURIComponent(authSource)}`,
                            {
                                serverSelectionTimeoutMS: env.STORAGE_READ_TIMEOUT_MS,
                                connectTimeoutMS: env.STORAGE_READ_TIMEOUT_MS,
                                maxPoolSize: 1,
                                readPreference: ReadPreference.secondaryPreferred,
                            }
                        );
                        this.peers.set(shard.host, client);
                    }
                    // Application clusterMonitor access is scoped to topology inspection.
                    const hello = await client
                        .db('admin')
                        .command({ hello: 1 }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
                    if (!hello.primary && !hello.secondary) throw new Error('No readable member');
                    if (hello.primary) primaries[shard._id] = hello.primary;
                    const status = await client
                        .db('admin')
                        .command({ replSetGetStatus: 1 }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
                    members[shard._id] = status.members;
                    for (const member of status.members) {
                        if (member.health !== 1 || ![1, 2].includes(member.state))
                            degraded.add(`${shard._id}/${member.name}`);
                    }
                } catch {
                    unavailable.add(shard._id);
                }
            })
        );
        if (this.cachedShards.length === 0) unavailable.add('canonical-store');
        return {
            shards: this.cachedShards,
            primaries,
            members,
            degraded_units: [...degraded].sort(),
            unavailable_units: [...unavailable].sort(),
        };
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
        const nodeMap = await this.nodeMap();
        if (
            process.env.KUBERNETES_SERVICE_HOST &&
            shard.host
                .split('/')[1]
                .split(',')
                .some((host) => !nodeMap[host.split('.')[0]])
        ) {
            throw new Error('A MongoDB member has no actual Kubernetes node mapping');
        }
        return shard.host
            .split('/')[1]
            .split(',')
            .filter(
                (host) =>
                    !topology.members?.[shard._id] ||
                    topology.members[shard._id].some(
                        (member) => member.name === host && member.health === 1 && [1, 2].includes(member.state)
                    )
            )
            .map((host) => ({
                node: nodeMap[host.split('.')[0]] ?? env.MONGO_NODE_MAP[host] ?? host.split(':')[0],
                unit: `${shard._id}/${host}`,
                role: host === primary ? 'primary' : 'replica',
            }));
    }

    private async nodeMap(): Promise<Record<string, string>> {
        if (!process.env.KUBERNETES_SERVICE_HOST) return {};
        const base = '/var/run/secrets/kubernetes.io/serviceaccount';
        const namespace = readFileSync(`${base}/namespace`, 'utf8').trim();
        const token = readFileSync(`${base}/token`, 'utf8').trim();
        return new Promise((resolve, reject) => {
            const request = get(
                {
                    hostname: process.env.KUBERNETES_SERVICE_HOST,
                    port: process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443',
                    path: `/api/v1/namespaces/${namespace}/pods?labelSelector=role%3Dstore`,
                    ca: readFileSync(`${base}/ca.crt`),
                    headers: { Authorization: `Bearer ${token}` },
                    timeout: env.STORAGE_READ_TIMEOUT_MS,
                },
                (response) => {
                    let body = '';
                    response.setEncoding('utf8');
                    response.on('data', (chunk) => {
                        body += chunk;
                    });
                    response.on('error', reject);
                    response.on('end', () => {
                        try {
                            if (response.statusCode !== 200) throw new Error('Pod topology unavailable');
                            const pods = JSON.parse(body).items as {
                                metadata: { name: string };
                                spec: { nodeName?: string };
                            }[];
                            resolve(
                                Object.fromEntries(
                                    pods
                                        .filter((pod) => pod.spec.nodeName)
                                        .map((pod) => [pod.metadata.name, pod.spec.nodeName!])
                                )
                            );
                        } catch (error) {
                            reject(error);
                        }
                    });
                }
            );
            request.on('timeout', () => request.destroy(new Error('Pod topology deadline exceeded')));
            request.on('error', reject);
        });
    }

    async close(): Promise<void> {
        await Promise.all([...this.peers.values()].map((client) => client.close()));
    }
}
