// Admin: per-plan AI model chain (primary + up to 2 fallbacks), with a live "Test" button.
// See lib/planModels.ts for how this is cached and resolved on the live chat/voice/booking paths.
import { Hono } from 'hono';
import { z } from 'zod';
import { testModelInvoke } from '../../lib/bedrock.js';
import { getAllPlanModelConfigs, upsertPlanModelConfig } from '../../lib/planModels.js';
import type { HonoEnv } from '../../types/index.js';

const router = new Hono<HonoEnv>();

const PLAN_IDS = ['starter', 'growth', 'enterprise'] as const;

// A curated, known-good set of Bedrock chat models — not the full raw catalog, which is mostly
// embedding/image models or variants that don't speak the Converse API this app uses.
export const MODEL_CATALOG = [
  { id: 'us.anthropic.claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-opus-4-6-v1', label: 'Claude Opus 4.6', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude Opus 4.5', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5', provider: 'Anthropic' },
  { id: 'us.anthropic.claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'Anthropic' },
  { id: 'mistral.mistral-large-3-675b-instruct', label: 'Mistral Large 3', provider: 'Mistral' },
  { id: 'us.amazon.nova-2-lite-v1:0', label: 'Nova 2 Lite', provider: 'Amazon' },
  { id: 'us.amazon.nova-pro-v1:0', label: 'Nova Pro', provider: 'Amazon' },
] as const;

// GET /api/admin/ai-models — current per-plan chain + the model catalog for the dropdowns
router.get('/', async (c) => {
  const configs = await getAllPlanModelConfigs();
  return c.json({ catalog: MODEL_CATALOG, configs });
});

const updateSchema = z.object({
  primaryModel: z.string().min(1),
  fallback1: z.string().nullable().optional(),
  fallback2: z.string().nullable().optional(),
});

// PUT /api/admin/ai-models/:planId — set this plan's model chain
router.put('/:planId', async (c) => {
  const planId = c.req.param('planId');
  if (!PLAN_IDS.includes(planId as (typeof PLAN_IDS)[number])) return c.json({ error: 'Unknown plan' }, 400);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' }, 400);

  await upsertPlanModelConfig(planId, {
    primaryModel: parsed.data.primaryModel,
    fallback1: parsed.data.fallback1 ?? null,
    fallback2: parsed.data.fallback2 ?? null,
  });
  const configs = await getAllPlanModelConfigs();
  return c.json({ configs });
});

const testSchema = z.object({ modelId: z.string().min(1) });

// POST /api/admin/ai-models/test — a real, minimal invoke of exactly this model (no fallback)
router.post('/test', async (c) => {
  const parsed = testSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'modelId required' }, 400);
  const result = await testModelInvoke(parsed.data.modelId);
  return c.json(result);
});

export default router;
