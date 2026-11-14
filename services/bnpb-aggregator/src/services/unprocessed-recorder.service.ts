import { inject, injectable } from 'inversify';
import { TYPES } from '../constants/types';
import { LeaseToken } from '../db/schema/background-leases';
import { logger } from '../libs/logger';
import { parseFailuresTotal } from '../libs/metrics';
import {
    IUnprocessedMessageRepository,
    RecordUnprocessedInput,
    RecordUnprocessedResult,
} from '../repositories/unprocessed-message.repository';

export interface IUnprocessedRecorder {
    record(input: RecordUnprocessedInput, lease?: LeaseToken): Promise<RecordUnprocessedResult>;
}

@injectable()
export class UnprocessedRecorder implements IUnprocessedRecorder {
    constructor(
        @inject(TYPES.IUnprocessedMessageRepository) private readonly repository: IUnprocessedMessageRepository
    ) {}

    async record(input: RecordUnprocessedInput, lease?: LeaseToken): Promise<RecordUnprocessedResult> {
        const result = await this.repository.record(input, lease);
        parseFailuresTotal.inc({ source: input.source, reason: input.error.category });
        logger.warn(
            {
                messageId: result.messageId,
                source: input.source,
                kind: input.context.kind,
                sourceRefId: input.sourceRefId ?? null,
                reason: input.error.reason,
                retryable: input.error.retryable,
                status: result.status,
                duplicate: !result.created,
                reopened: result.reopened,
                correlationId: input.correlationId,
            },
            'Stored unprocessed message'
        );
        return result;
    }
}
