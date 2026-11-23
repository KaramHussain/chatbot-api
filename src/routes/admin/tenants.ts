import { Hono } from 'hono';
import { jsonBody } from '../../lib/validation.js';
import { z } from 'zod';
import { db, tenants, users, bots, adminAuditLogs, botChunks, botDocuments, conversations } from '../../db/index.js';
import { eq, desc, and, ne, or, count } from 'drizzle-orm';
import { PLAN_CONFIG } from '../../config/plans.js';
import bcrypt from 'bcryptjs';
import type { HonoEnv } from '../../types/index.js';

const router = new Hono<HonoEnv>();
const safeUser = { id: users.id, username: users.username, email: users.email,
  name: users.name, role: users.role, tenantId: users.tenantId, createdAt: users.createdAt };
const usernameSchema = z.string().trim().toLowerCase().min(3).max(50)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use letters, numbers, dots, underscores or hyphens');
const passwordSchema = z.string().min(8).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72,
  'Password must be no more than 72 bytes');
const userSchema = z.object({ name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().toLowerCase(), username: usernameSchema,
  password: passwordSchema, role: z.enum(['client_admin', 'client_user']).default('client_admin') });

// Handle uniqueness races as well as friendly preflight checks. Never return SQL/credential details.
router.onError((error, c) => {
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  if ((error as Error & { code?: string }).code === '23505' || cause?.code === '23505') {
    return c.json({ error: 'That email, username or account address is already in use.' }, 409);
  }
  throw error;
});
router.use('/:id/*', async (c, next) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Invalid tenant' }, 400);
  await next();
});

// GET /api/admin/tenants
router.get('/', async (c) => {
  const rows = await db.select().from(tenants).orderBy(desc(tenants.createdAt));
  const [members, botCounts] = await Promise.all([
    db.select(safeUser).from(users).orderBy(users.createdAt),
    db.select({ tenantId: bots.tenantId, total: count() }).from(bots).groupBy(bots.tenantId),
  ]);
  const counts = new Map(botCounts.map(r => [r.tenantId, r.total]));
  const grouped = new Map<string, typeof members>();
  for (const user of members) if (user.tenantId) grouped.set(user.tenantId, [...(grouped.get(user.tenantId) ?? []), user]);
  return c.json({ tenants: rows.map(t => ({ ...t, users: grouped.get(t.id) ?? [], botCount: counts.get(t.id) ?? 0 })) });
});

router.get('/:id/resources', async (c) => {
  const { id } = c.req.param();
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id));
  if (!tenant) return c.json({ error: 'Not found' }, 404);
  const [members, tenantBots, audit] = await Promise.all([
    db.select(safeUser).from(users).where(eq(users.tenantId, id)).orderBy(users.createdAt),
    db.select({ id: bots.id, name: bots.name, status: bots.status, updatedAt: bots.updatedAt })
      .from(bots).where(eq(bots.tenantId, id)).orderBy(desc(bots.updatedAt)),
    db.select({ id: adminAuditLogs.id, actorId: adminAuditLogs.actorId, action: adminAuditLogs.action,
      resource: adminAuditLogs.resource, createdAt: adminAuditLogs.createdAt, actorName: users.name })
      .from(adminAuditLogs).leftJoin(users, eq(users.id, adminAuditLogs.actorId))
      .where(eq(adminAuditLogs.tenantId, id)).orderBy(desc(adminAuditLogs.createdAt)).limit(50),
  ]);
  return c.json({ users: members, bots: tenantBots, audit });
});

router.post('/:id/users', jsonBody(userSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id));
  if (!tenant) return c.json({ error: 'Not found' }, 404);
  const passwordHash = await bcrypt.hash(body.password, 12);
  const [user] = await db.insert(users).values({ tenantId: id, name: body.name, email: body.email,
    username: body.username, role: body.role, passwordHash }).returning(safeUser);
  return c.json({ user }, 201);
});

router.patch('/:id/users/:userId', jsonBody(userSchema.partial()), async (c) => {
  const { id, userId } = c.req.param();
  if (!z.string().uuid().safeParse(userId).success) return c.json({ error: 'Invalid user' }, 400);
  const { password, ...body } = c.req.valid('json');
  // A tenant user can never be promoted to global admin through these endpoints.
  const result = await db.transaction(async (tx) => {
    // Serialize membership changes so concurrent requests cannot remove the last owner.
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).for('update');
    const [member] = await tx.select({ role: users.role }).from(users)
      .where(and(eq(users.id, userId), eq(users.tenantId, id), ne(users.role, 'super_admin')));
    if (!member) return { missing: true };
    if (member.role === 'client_admin' && body.role === 'client_user') {
      const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, id), eq(users.role, 'client_admin')));
      if (admins.length <= 1) return { lastOwner: true };
    }
    const [user] = await tx.update(users).set({ ...body, updatedAt: new Date(),
      ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}) })
      .where(and(eq(users.id, userId), eq(users.tenantId, id))).returning(safeUser);
    return { user };
  });
  if (result.missing) return c.json({ error: 'User not found in this account' }, 404);
  if (result.lastOwner) return c.json({ error: 'Keep at least one account owner.' }, 409);
  return c.json({ user: result.user });
});

// GET /api/admin/tenants/:id
router.get('/:id', async (c) => {
  const { id } = c.req.param();
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  if (!tenant) return c.json({ error: 'Not found' }, 404);
  return c.json({ tenant });
});

// POST /api/admin/tenants — create a new client account
const createTenantSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Only lowercase letters, numbers, and hyphens'),
  plan: z.enum(['starter', 'growth', 'enterprise']).default('starter'),
  aiModel: z.string().optional(),
  adminEmail: z.string().email(),
  adminUsername: usernameSchema,
  adminName: z.string().min(2),
  adminPassword: passwordSchema,
});

router.post('/', jsonBody(createTenantSchema), async (c) => {
  const body = c.req.valid('json');

  // Check slug uniqueness
  const [existingSlug] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, body.slug))
    .limit(1);

  if (existingSlug) return c.json({ error: 'Slug already taken' }, 409);

  // Check email uniqueness
  const [existingEmail] = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.email, body.adminEmail.toLowerCase()), eq(users.username, body.adminUsername)))
    .limit(1);

  if (existingEmail) return c.json({ error: 'Email or username already registered' }, 409);

  // Create tenant
  const passwordHash = await bcrypt.hash(body.adminPassword, 12);
  const result = await db.transaction(async (tx) => {
    const plan = PLAN_CONFIG[body.plan];
    const [tenant] = await tx
      .insert(tenants)
      .values({
        name: body.name,
        slug: body.slug,
        plan: body.plan,
        monthlyMessageLimit: plan.monthlyMessageLimit,
        monthlyTokenBudget: plan.monthlyTokenBudget,
        aiModel: body.aiModel ?? plan.aiModel,
      })
      .returning();

    // Create the account owner in the same transaction.
    const [user] = await tx
      .insert(users)
      .values({
        tenantId: tenant.id,
        email: body.adminEmail.toLowerCase(),
        username: body.adminUsername,
        passwordHash,
        name: body.adminName,
        role: 'client_admin',
      })
      .returning(safeUser);
    return { tenant, user };
  });
  c.set('tenantId', result.tenant.id);

  return c.json(result, 201);
});

// PUT /api/admin/tenants/:id — update plan/status/model/budget/session
const updateTenantSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  plan: z.enum(['starter', 'growth', 'enterprise']).optional(),
  status: z.enum(['active', 'suspended', 'pending']).optional(),
  monthlyMessageLimit: z.number().int().min(0).optional(),
  aiModel: z.string().optional(),
  monthlyTokenBudget: z.number().int().min(0).optional(),
  sessionDurationMinutes: z.number().int().min(1).max(43200).optional(),
  maxUploadMb: z.number().int().min(1).max(500).nullable().optional(),
  // Per-tenant feature switches overriding the plan default, e.g. { booking: true }. Omit a key to follow the plan.
  featureOverrides: z.record(z.enum(['booking']), z.boolean()).optional(),
});

router.put('/:id', jsonBody(updateTenantSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const [updated] = await db
    .update(tenants)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(tenants.id, id))
    .returning();

  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ tenant: updated });
});

// DELETE /api/admin/tenants/:id/data — wipe RAG data only (keep account)
router.delete('/:id/data', async (c) => {
  const { id } = c.req.param();

  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).limit(1);
  if (!tenant) return c.json({ error: 'Not found' }, 404);

  await db.delete(botChunks).where(eq(botChunks.tenantId, id));
  await db.delete(botDocuments).where(eq(botDocuments.tenantId, id));
  await db.delete(conversations).where(eq(conversations.tenantId, id));

  return c.json({ success: true });
});

// DELETE /api/admin/tenants/:id — delete tenant + everything
router.delete('/:id', async (c) => {
  const { id } = c.req.param();

  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).limit(1);
  if (!tenant) return c.json({ error: 'Not found' }, 404);

  // Cascade: bots → chunks, documents, conversations, messages all cascade
  await db.delete(tenants).where(eq(tenants.id, id));

  return c.json({ success: true });
});

export default router;
