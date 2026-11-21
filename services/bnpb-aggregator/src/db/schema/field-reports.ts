export const fieldReports = 'field_reports';

// D-39: one document per report_id (_id = report_id, hashed shard key); first write wins
export interface StoredFieldReport {
    _id: string;
    reportId: string;
    hazardType: string;
    latitude: number;
    longitude: number;
    description: string;
    severityEstimate: string;
    reportedAt: Date;
    reporter: { sub: string; role: string };
    acceptedAt: Date;
    processedAt: Date;
    contentSha256: string;
    kafka: { topic: string; partition: number; offset: string } | null;
    correlationId: string;
    // deliveries of an identical message (at-least-once redelivery or client resend)
    deliveries: number;
}
