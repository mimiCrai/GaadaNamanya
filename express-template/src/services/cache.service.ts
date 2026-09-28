import { injectable } from 'inversify';
import { createClient, RedisClientType } from 'redis';
import env from '../util/env';
import { logger } from '../libs/logger';

export interface ICacheService {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<void>;
}

@injectable()
export class CacheService implements ICacheService {
    private client: RedisClientType;

    constructor() {
        this.client = createClient({ url: env.REDIS_URL });

        this.client.on('error', (err) => {
            logger.error({ err }, 'Redis connection error');
        });

        this.client.on('connect', () => {
            logger.info('Redis connected');
        });

        this.client.connect();
    }

    async get<T>(key: string): Promise<T | null> {
        const value = await this.client.get(key);
        if (!value) return null;

        try {
            return JSON.parse(value) as T;
        } catch {
            return value as T;
        }
    }

    async set(key: string, value: unknown, ttlSeconds = 3600): Promise<void> {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        await this.client.set(key, serialized, { EX: ttlSeconds });
    }

    async del(key: string): Promise<void> {
        await this.client.del(key);
    }

    async close(): Promise<void> {
        await this.client.quit();
        logger.info('Redis connection closed');
    }
}
