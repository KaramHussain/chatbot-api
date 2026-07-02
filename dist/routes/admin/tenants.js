import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, tenants, users, botChunks, botDocuments, conversations } from '../../db/index.js';
import { eq, desc } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
const router = new Hono();
// GET /api/admin/tenants
router.get('/', async (c) => {
    const rows = await db.select().from(tenants).orderBy(desc(tenants.createdAt));
    return c.json({ tenants: rows });
});
// GET /api/admin/tenants/:id
router.get('/:id', async (c) => {
    const { id } = c.req.param();
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant)
        return c.json({ error: 'Not found' }, 404);
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
    adminName: z.string().min(2),
    // Temporary password — client must change on first login
    adminPassword: z.string().min(8),
});
router.post('/', zValidator('json', createTenantSchema), async (c) => {
    const body = c.req.valid('json');
    // Check slug uniqueness
    const [existingSlug] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, body.slug))
        .limit(1);
    if (existingSlug)
        return c.json({ error: 'Slug already taken' }, 409);
    // Check email uniqueness
    const [existingEmail] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, body.adminEmail.toLowerCase()))
        .limit(1);
    if (existingEmail)
        return c.json({ error: 'Email already registered' }, 409);
    // Create tenant
    const [tenant] = await db
        .insert(tenants)
        .values({
        name: body.name,
        slug: body.slug,
        plan: body.plan,
        ...(body.aiModel ? { aiModel: body.aiModel } : {}),
    })
        .returning();
    // Hash password and create admin user
    const passwordHash = await bcrypt.hash(body.adminPassword, 12);
    const [user] = await db
        .insert(users)
        .values({
        tenantId: tenant.id,
        email: body.adminEmail.toLowerCase(),
        passwordHash,
        name: body.adminName,
        role: 'client_admin',
    })
        .returning({ id: users.id, email: users.email, name: users.name });
    return c.json({ tenant, user }, 201);
});
// PUT /api/admin/tenants/:id — update plan/status/model/budget/session
const updateTenantSchema = z.object({
    plan: z.enum(['starter', 'growth', 'enterprise']).optional(),
    status: z.enum(['active', 'suspended', 'pending']).optional(),
    monthlyMessageLimit: z.number().int().min(0).optional(),
    aiModel: z.string().optional(),
    monthlyTokenBudget: z.number().int().min(0).optional(),
    sessionDurationMinutes: z.number().int().min(1).max(43200).optional(),
    maxUploadMb: z.number().int().min(1).max(500).nullable().optional(),
});
router.put('/:id', zValidator('json', updateTenantSchema), async (c) => {
    const { id } = c.req.param();
    const body = c.req.valid('json');
    const [updated] = await db
        .update(tenants)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(tenants.id, id))
        .returning();
    if (!updated)
        return c.json({ error: 'Not found' }, 404);
    return c.json({ tenant: updated });
});
// DELETE /api/admin/tenants/:id/data — wipe RAG data only (keep account)
router.delete('/:id/data', async (c) => {
    const { id } = c.req.param();
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant)
        return c.json({ error: 'Not found' }, 404);
    await db.delete(botChunks).where(eq(botChunks.tenantId, id));
    await db.delete(botDocuments).where(eq(botDocuments.tenantId, id));
    await db.delete(conversations).where(eq(conversations.tenantId, id));
    return c.json({ success: true });
});
// DELETE /api/admin/tenants/:id — delete tenant + everything
router.delete('/:id', async (c) => {
    const { id } = c.req.param();
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!tenant)
        return c.json({ error: 'Not found' }, 404);
    // Cascade: bots → chunks, documents, conversations, messages all cascade
    await db.delete(tenants).where(eq(tenants.id, id));
    return c.json({ success: true });
});
export default router;
//# sourceMappingURL=tenants.js.map