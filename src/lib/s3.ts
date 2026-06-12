import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { awsConfig } from './aws.js';

const s3 = new S3Client(awsConfig);
const BUCKET = process.env.S3_BUCKET_NAME!;

// Generate a presigned PUT URL so the dashboard can upload directly to S3
// without proxying the file through our API
export async function getPresignedUploadUrl(params: {
  key: string;
  contentType: string;
  fileSizeLimit?: number;
}): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: params.key,
    ContentType: params.contentType,
  });

  return getSignedUrl(s3, command, { expiresIn: 900 }); // 15 minutes
}

// Generate a presigned GET URL for the RAG pipeline to download the file
export async function getPresignedDownloadUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// S3 key convention: tenants/{tenantId}/bots/{botId}/docs/{docId}/{filename}
export function buildDocumentKey(params: {
  tenantId: string;
  botId: string;
  documentId: string;
  filename: string;
}): string {
  const safe = params.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `tenants/${params.tenantId}/bots/${params.botId}/docs/${params.documentId}/${safe}`;
}

// S3 key for bot logos
export function buildLogoKey(tenantId: string, botId: string, ext: string): string {
  return `tenants/${tenantId}/bots/${botId}/logo.${ext}`;
}

// Upload a buffer directly to S3 (for server-side uploads)
export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

// Get an S3 object and return its stream + content-type
export async function getObjectStream(key: string): Promise<{ body: ReadableStream; contentType: string }> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return {
    body: res.Body as unknown as ReadableStream,
    contentType: res.ContentType ?? 'application/octet-stream',
  };
}
