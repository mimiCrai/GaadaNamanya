import { inject, injectable } from 'inversify';
import { MongoServerError } from 'mongodb';
import { TYPES } from '../constants/types';
import { CanonicalStore } from '../db';
import { fieldReports, StoredFieldReport } from '../db/schema/field-reports';
import { FieldReportMessage, fieldReportContentSha256 } from '../libs/field-report';
import env from '../util/env';

export type FieldReportWriteResult = 'created' | 'duplicate' | 'conflict';

export interface KafkaPosition {
    topic: string;
    partition: number;
    offset: string;
}

export interface FieldReportWrite {
    result: FieldReportWriteResult;
    report: StoredFieldReport;
    incomingSha256: string;
}

export interface IFieldReportRepository {
    insertOnce(message: FieldReportMessage, kafka: KafkaPosition | null, correlationId: string): Promise<FieldReportWrite>;
    findById(reportId: string): Promise<StoredFieldReport | null>;
    list(after: string | undefined, limit: number): Promise<StoredFieldReport[]>;
}

/**
 * D-39: idempotent insert addressed by _id = report_id (shard key). No lease: any replica may serve it,
 * because a second insert of the same id can only find the first document (first write wins).
 */
@injectable()
export class FieldReportRepository implements IFieldReportRepository {
    constructor(@inject(TYPES.Database) private readonly db: CanonicalStore) {}

    private collection() {
        return this.db.collection<StoredFieldReport>(fieldReports);
    }

    async insertOnce(message: FieldReportMessage, kafka: KafkaPosition | null, correlationId: string): Promise<FieldReportWrite> {
        const { report, reporter } = message;
        const incomingSha256 = fieldReportContentSha256(message);
        const document: Omit<StoredFieldReport, 'deliveries' | 'processedAt'> = {
            _id: report.report_id,
            reportId: report.report_id,
            hazardType: report.hazard_type,
            latitude: report.latitude,
            longitude: report.longitude,
            description: report.description,
            severityEstimate: report.severity_estimate,
            reportedAt: new Date(report.reported_at),
            reporter,
            acceptedAt: new Date(message.accepted_at),
            contentSha256: incomingSha256,
            kafka,
            correlationId,
        };
        for (let attempt = 0; ; attempt++) {
            try {
                const write = await this.collection().findOneAndUpdate(
                    { _id: report.report_id },
                    { $setOnInsert: { ...document, processedAt: new Date() }, $inc: { deliveries: 1 } },
                    { upsert: true, returnDocument: 'after', includeResultMetadata: true, timeoutMS: env.LEASE_OPERATION_TIMEOUT_MS }
                );
                const stored = write.value!;
                const created = write.lastErrorObject?.updatedExisting === false;
                const result: FieldReportWriteResult = created
                    ? 'created'
                    : stored.contentSha256 === incomingSha256
                      ? 'duplicate'
                      : 'conflict';
                return { result, report: stored, incomingSha256 };
            } catch (error) {
                // concurrent first inserts of one id: the loser retries and finds the winner
                if (!(error instanceof MongoServerError) || error.code !== 11000 || attempt >= 2) throw error;
            }
        }
    }

    async findById(reportId: string): Promise<StoredFieldReport | null> {
        return this.collection().findOne({ _id: reportId }, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS });
    }

    // verification listing (proof script): ordered by _id, keyset pagination
    async list(after: string | undefined, limit: number): Promise<StoredFieldReport[]> {
        return this.collection()
            .find(after ? { _id: { $gt: after } } : {}, { timeoutMS: env.STORAGE_READ_TIMEOUT_MS })
            .sort({ _id: 1 })
            .limit(limit)
            .toArray();
    }
}
