import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';

const region = process.env.AWS_REGION ?? 'us-east-1';

function getCredentials(profile: string): AwsCredentialIdentityProvider {
  if (process.env.NODE_ENV === 'production') {
    return fromNodeProviderChain();
  }
  return fromIni({ profile });
}

// Config for infrastructure: S3, SQS — uses the shaheen profile (our own AWS account)
export const awsConfig = {
  region,
  credentials: getCredentials(process.env.AWS_PROFILE ?? 'shaheen'),
};

// Config for AI: Bedrock LLM + Embeddings — uses kickid profile (separate account with quota)
export const bedrockAwsConfig = {
  region: process.env.BEDROCK_REGION ?? region,
  credentials: getCredentials(process.env.BEDROCK_AWS_PROFILE ?? 'kickid'),
};
