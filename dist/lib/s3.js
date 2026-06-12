import { S3Client, DeleteObjectCommand, GetObjectCommand, } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { awsConfig } from './aws.js';
const s3 = new S3Client(awsConfig);
const BUCKET = process.env.S3_BUCKET_NAME;
// Generate a presigned PUT URL so the dashboard can upload directly to S3
// without proxying the file through our API
export async function getPresignedUploadUrl(params) {
    const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: params.key,
        ContentType: params.contentType,
    });
    return getSignedUrl(s3, command, { expiresIn: 900 }); // 15 minutes
}
// Generate a presigned GET URL for the RAG pipeline to download the file
export async function getPresignedDownloadUrl(key) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(s3, command, { expiresIn: 3600 });
}
export async function deleteObject(key) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}
// S3 key convention: tenants/{tenantId}/bots/{botId}/docs/{docId}/{filename}
export function buildDocumentKey(params) {
    const safe = params.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `tenants/${params.tenantId}/bots/${params.botId}/docs/${params.documentId}/${safe}`;
}
// S3 key for bot logos
export function buildLogoKey(tenantId, botId, ext) {
    return `tenants/${tenantId}/bots/${botId}/logo.${ext}`;
}
//# sourceMappingURL=s3.js.map