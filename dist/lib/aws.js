import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
const region = process.env.AWS_REGION ?? 'us-east-1';
function getCredentials(profile) {
    if (process.env.NODE_ENV === 'production') {
        return fromNodeProviderChain(); // picks up AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
    }
    return fromIni({ profile });
}
function getBedrockCredentials() {
    // In production, prefer explicit BEDROCK_AWS_ACCESS_KEY_ID (separate account from S3/SQS)
    if (process.env.NODE_ENV === 'production' && process.env.BEDROCK_AWS_ACCESS_KEY_ID) {
        return async () => ({
            accessKeyId: process.env.BEDROCK_AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.BEDROCK_AWS_SECRET_ACCESS_KEY,
        });
    }
    if (process.env.NODE_ENV === 'production') {
        return fromNodeProviderChain();
    }
    return fromIni({ profile: process.env.BEDROCK_AWS_PROFILE ?? 'kickid' });
}
// Config for infrastructure: S3, SQS — uses the shaheen profile / AWS_ACCESS_KEY_ID
export const awsConfig = {
    region,
    credentials: getCredentials(process.env.AWS_PROFILE ?? 'shaheen'),
};
// Config for AI: Bedrock LLM + Embeddings — uses kickid profile / BEDROCK_AWS_ACCESS_KEY_ID
export const bedrockAwsConfig = {
    region: process.env.BEDROCK_REGION ?? region,
    credentials: getBedrockCredentials(),
};
//# sourceMappingURL=aws.js.map