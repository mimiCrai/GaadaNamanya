export interface KafkaRecord {
    topic: string;
    partition: number;
    offset: string;
    value: Buffer | null;
    headers: Record<string, string>;
}

export interface KafkaPosition {
    topic: string;
    partition: number;
    offset: string;
}

export type StoreResult = 'created' | 'duplicate' | 'conflict';

// what happened to one Kafka record before its offset was committed
export type ProcessOutcome = StoreResult | 'dlq';

export interface UnprocessedRecord {
    kind: string;
    topic: string;
    payload: Buffer;
    correlationId: string;
    sourceRefId: string | null;
    category: 'malformed_json' | 'invalid_utf8' | 'payload_too_large' | 'validation_failed' | 'conflict' | 'retry_exhausted';
    detail: string;
}
