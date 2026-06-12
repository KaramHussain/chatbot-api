import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { awsConfig } from './aws.js';

const sqs = new SQSClient(awsConfig);
const QUEUE_URL = process.env.SQS_INGESTION_QUEUE_URL!;

export interface IngestionJob {
  documentId: string;
  botId: string;
  tenantId: string;
  documentType: string;
  documentName: string;
  // File uploads
  s3Key?: string;
  // URL scraping
  sourceUrl?: string;
  maxPages?: number;
}

export async function queueIngestionJob(job: IngestionJob): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(job),
      // Group by botId so jobs for the same bot are processed in order
      MessageGroupId: job.botId,
      MessageDeduplicationId: job.documentId,
    })
  );
}
