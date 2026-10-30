import { zValidator } from '@hono/zod-validator';
import type { ZodTypeAny } from 'zod';

/**
 * JSON body validator that answers bad input with a readable `{ error }` naming the field,
 * e.g. "systemPrompt: String must contain at most 4000 character(s)" — the dashboard shows it as-is.
 */
export const jsonBody = <T extends ZodTypeAny>(schema: T) =>
  zValidator('json', schema, (result, c) => {
    if (result.success) return;
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || 'request';
    return c.json({ error: `${field}: ${issue?.message ?? 'invalid value'}` }, 400);
  });
