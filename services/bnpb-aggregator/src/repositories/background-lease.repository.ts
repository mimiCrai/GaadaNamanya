import { inject, injectable } from 'inversify';
import { ClientSession } from 'mongodb';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import {
    BackgroundLease,
    backgroundLeaseId,
    backgroundLeases,
    LeaseLostError,
    LeaseToken,
} from '../db/schema/background-leases';
import env from '../util/env';

export interface IBackgroundLeaseRepository {
    acquireOrRenew(ownerId: string): Promise<BackgroundLease | null>;
    requireActive(token: LeaseToken, session?: ClientSession): Promise<Date>;
    withLease<T>(token: LeaseToken, work: (session: ClientSession, at: Date) => Promise<T>): Promise<T>;
    release(token: LeaseToken): Promise<void>;
    inspect(): Promise<BackgroundLease | null>;
}

@injectable()
export class BackgroundLeaseRepository implements IBackgroundLeaseRepository {
    constructor(@inject(TYPES.Database) private readonly store: CanonicalStore) {}

    async acquireOrRenew(ownerId: string): Promise<BackgroundLease | null> {
        const expired = { $lte: ['$expiresAt', '$$NOW'] };
        const lease = await this.store.collection<BackgroundLease>(backgroundLeases).findOneAndUpdate(
            { _id: backgroundLeaseId, $expr: { $or: [{ $eq: ['$ownerId', { $literal: ownerId }] }, expired] } },
            [
                {
                    $set: {
                        epoch: {
                            $cond: [
                                { $and: [{ $eq: ['$ownerId', { $literal: ownerId }] }, { $not: [expired] }] },
                                '$epoch',
                                { $add: ['$epoch', 1] },
                            ],
                        },
                        ownerId: { $literal: ownerId },
                        expiresAt: { $max: ['$expiresAt', { $add: ['$$NOW', env.BACKGROUND_LEASE_MS] }] },
                        checkedAt: '$$NOW',
                    },
                },
            ],
            {
                returnDocument: 'after',
                timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS,
                maxTimeMS: env.LEASE_OPERATION_TIMEOUT_MS,
            }
        );
        if (!lease) return null;
        // A grant delayed behind a frozen transaction may have expired before the reply arrived.
        try {
            await this.requireActive({ ownerId, epoch: lease.epoch });
            return lease;
        } catch (error) {
            if (error instanceof LeaseLostError) return null;
            throw error;
        }
    }

    async requireActive(token: LeaseToken, session?: ClientSession): Promise<Date> {
        const result = await this.store.collection<BackgroundLease>(backgroundLeases).findOneAndUpdate(
            {
                _id: backgroundLeaseId,
                ownerId: token.ownerId,
                epoch: token.epoch,
                $expr: { $gt: ['$expiresAt', '$$NOW'] },
            },
            [{ $set: { checkedAt: '$$NOW', guardVersion: { $add: ['$guardVersion', 1] } } }],
            { session, returnDocument: 'after', ...(session ? {} : { timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS }) }
        );
        if (!result) throw new LeaseLostError();
        return result.checkedAt;
    }

    async withLease<T>(token: LeaseToken, work: (session: ClientSession, at: Date) => Promise<T>): Promise<T> {
        const session = this.store.client.startSession();
        try {
            return await session.withTransaction(
                async () => {
                    const at = await this.requireActive(token, session);
                    const result = await work(session, at);
                    await this.requireActive(token, session);
                    return result;
                },
                {
                    readConcern: { level: 'snapshot' },
                    writeConcern: { w: 'majority', j: true },
                    readPreference: 'primary',
                    maxCommitTimeMS: env.LEASE_OPERATION_TIMEOUT_MS,
                    timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS,
                }
            );
        } finally {
            await session.endSession();
        }
    }

    async release(token: LeaseToken): Promise<void> {
        await this.store
            .collection<BackgroundLease>(backgroundLeases)
            .updateOne(
                { _id: backgroundLeaseId, ownerId: token.ownerId, epoch: token.epoch },
                [{ $set: { expiresAt: '$$NOW' } }],
                { timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS }
            );
    }

    async inspect(): Promise<BackgroundLease | null> {
        return this.store.collection<BackgroundLease>(backgroundLeases).findOne(
            { _id: backgroundLeaseId },
            {
                projection: { _id: 0 },
                timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS,
            }
        );
    }
}
