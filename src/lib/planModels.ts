// Admin-editable, per-plan model chain (see db/schema.ts `planModelConfig`). Cached in memory —
// refreshed at boot and after every admin write — so resolving a chain on the hot chat path never
// costs a DB round trip.
import { db, planModelConfig } from '../db/index.js';

export interface PlanModelConfig {
  primaryModel: string;
  fallback1: string | null;
  fallback2: string | null;
}

// Used only until the first refresh completes (e.g. the first request right after boot) and as a
// safety net for a plan with no row — the same values migrate.ts seeds.
const DEFAULTS: Record<string, PlanModelConfig> = {
  starter: { primaryModel: 'us.amazon.nova-2-lite-v1:0', fallback1: null, fallback2: null },
  growth: { primaryModel: 'us.anthropic.claude-opus-4-5-20251101-v1:0', fallback1: 'mistral.mistral-large-3-675b-instruct', fallback2: 'us.amazon.nova-2-lite-v1:0' },
  enterprise: { primaryModel: 'us.anthropic.claude-opus-4-5-20251101-v1:0', fallback1: 'mistral.mistral-large-3-675b-instruct', fallback2: 'us.amazon.nova-2-lite-v1:0' },
};

let cache: Map<string, PlanModelConfig> = new Map(Object.entries(DEFAULTS));

export async function refreshPlanModelCache(): Promise<void> {
  const rows = await db.select().from(planModelConfig);
  const next = new Map(Object.entries(DEFAULTS));
  for (const r of rows) {
    next.set(r.planId, { primaryModel: r.primaryModel, fallback1: r.fallback1, fallback2: r.fallback2 });
  }
  cache = next;
}

export function getPlanModelConfig(planId: string): PlanModelConfig {
  return cache.get(planId) ?? DEFAULTS.starter;
}

/**
 * The ordered list of model ids to try for this plan. `override` (a bot's own llmModel, or a
 * tenant's deliberately-set aiModel) takes the primary slot when present; the plan's configured
 * fallbacks always apply after it. Deduplicated, nulls dropped.
 */
export function buildModelChain(planId: string, override?: string | null): string[] {
  const cfg = getPlanModelConfig(planId);
  const chain = [override || cfg.primaryModel, cfg.fallback1, cfg.fallback2];
  return [...new Set(chain.filter((m): m is string => !!m))];
}

export async function upsertPlanModelConfig(planId: string, cfg: PlanModelConfig): Promise<void> {
  await db
    .insert(planModelConfig)
    .values({ planId, primaryModel: cfg.primaryModel, fallback1: cfg.fallback1, fallback2: cfg.fallback2, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: planModelConfig.planId,
      set: { primaryModel: cfg.primaryModel, fallback1: cfg.fallback1, fallback2: cfg.fallback2, updatedAt: new Date() },
    });
  await refreshPlanModelCache();
}

export async function getAllPlanModelConfigs(): Promise<Record<string, PlanModelConfig>> {
  await refreshPlanModelCache();
  return Object.fromEntries(cache.entries());
}
