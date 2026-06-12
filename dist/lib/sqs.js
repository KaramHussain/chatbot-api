import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { awsConfig } from './aws.js';
const sqs = new SQSClient(awsConfig);
const QUEUE_URL = process.env.SQS_INGESTION_QUEUE_URL;
export async function queueIngestionJob(job) {
    await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(job),
        // Group by botId so jobs for the same bot are processed in order
        MessageGroupId: job.botId,
        MessageDeduplicationId: job.documentId,
    }));
}
//# sourceMappingURL=sqs.js.map