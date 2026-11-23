import { z } from 'zod';

export function canonicalWebsiteUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = '';
  return url.toString();
}

export const websiteUrlSchema = z.string().trim().url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}, 'Use a public http or https website address without login details').transform(canonicalWebsiteUrl);
