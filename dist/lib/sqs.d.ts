export interface IngestionJob {
    documentId: string;
    botId: string;
    tenantId: string;
    documentType: string;
    documentName: string;
    s3Key?: string;
    sourceUrl?: string;
    maxPages?: number;
    jobId?: string;
    pageUrl?: string;
}
export declare function queueIngestionJob(job: IngestionJob): Promise<void>;
//# sourceMappingURL=sqs.d.ts.map