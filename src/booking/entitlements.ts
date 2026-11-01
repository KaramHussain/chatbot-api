// The single place that decides whether a tenant may use Bookings.
//   env FEATURE_BOOKING=false        → off for everyone (kill switch)
//   tenants.feature_overrides.booking → per-tenant override (admin)
//   PLAN_CONFIG[plan].features.booking → plan default
// When off, the dashboard hides the UI, routes answer 403, the widget gets no booking config and the AI
// gets no booking tools. Existing booking rows are kept so re-enabling restores everything.
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { db, tenants } from '../db/index.js';
import { PLAN_CONFIG, isPlanId, type FeatureId } from '../config/plans.js';

export interface TenantFeatureRow {
  plan: string;
  featureOverrides: Record<string, boolean> | null;
}

export function bookingKillSwitchOn(): boolean {
  return process.env.FEATURE_BOOKING === 'false';
}

export function hasFeature(tenant: TenantFeatureRow | undefined, feature: FeatureId): boolean {
  if (!tenant) return false;
  if (feature === 'booking' && bookingKillSwitchOn()) return false;
  const override = tenant.featureOverrides?.[feature];
  if (typeof override === 'boolean') return override;
  const plan = isPlanId(tenant.plan) ? PLAN_CONFIG[tenant.plan] : PLAN_CONFIG.starter;
  return plan.features[feature];
}

export async function loadTenantFeatures(tenantId: string): Promise<TenantFeatureRow | undefined> {
  const [row] = await db
    .select({ plan: tenants.plan, featureOverrides: tenants.featureOverrides })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row;
}

export async function tenantHasBooking(tenantId: string): Promise<boolean> {
  return hasFeature(await loadTenantFeatures(tenantId), 'booking');
}

/** Entitlement map for the dashboard (`GET /api/account/entitlements`). */
export async function entitlementsFor(tenantId: string): Promise<Record<FeatureId, boolean>> {
  const row = await loadTenantFeatures(tenantId);
  return { booking: hasFeature(row, 'booking') };
}

/** Guard for owner routes. Requires the auth + requireTenant middleware to have run first. */
export const requireBookingFeature = createMiddleware<{ Variables: { tenantId: string } }>(async (c, next) => {
  if (!(await tenantHasBooking(c.get('tenantId')))) {
    return c.json({ error: 'Bookings is not available on your plan', upgrade: true }, 403);
  }
  await next();
});
