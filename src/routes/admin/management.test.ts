import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db, users, tenants, bots, botDocuments, tenantThemes, adminAuditLogs, emailVerifications } from '../../db/index.js';
import { signToken, verifyToken } from '../../middleware/auth.js';
import api from '../index.js';
import { getActiveBot } from '../../lib/conversation.js';
import { generateKeyPair, SignJWT } from 'jose';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';

const googleFixture = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'roles-test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'roles-test-only';
  return { key: undefined as any };
});
// Only replace Google's network key lookup. jose still verifies real RS256 signatures and claims.
vi.mock('jose', async importOriginal => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, createRemoteJWKSet: () => async () => googleFixture.key };
});

vi.mock('../../lib/sqs.js', () => ({ queueIngestionJob: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail: vi.fn() }) } }));
if (!process.env.DATABASE_URL?.includes('localhost:55432')) throw new Error('Use the isolated local test database.');
const app = new Hono().route('/api', api);
app.onError((e, c) => e instanceof HTTPException ? c.json({ error: e.message }, e.status) : c.json({ error: e.message }, 500));
const ids = { admin: randomUUID(), owner: randomUUID(), other: randomUUID(), a: randomUUID(), b: randomUUID(), botA: randomUUID(), botB: randomUUID() };
let adminToken: string, ownerToken: string, otherToken: string;
const createdTenants: string[] = [ids.a, ids.b];
async function request(path: string, token = adminToken, method = 'GET', body?: unknown, scope?: string) {
  return app.request(`/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(scope ? { 'X-Tenant-ID': scope } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function json(res: Response): Promise<any> { return res.json(); }
beforeAll(async () => {
  await db.insert(tenants).values([{ id: ids.a, name: 'Role test A', slug: ids.a }, { id: ids.b, name: 'Role test B', slug: ids.b }]);
  const hash = await bcrypt.hash('test-password-123', 12);
  await db.insert(users).values([
    { id: ids.admin, email: `${ids.admin}@example.test`, name: 'Test admin', role: 'super_admin' },
    { id: ids.owner, tenantId: ids.a, email: `${ids.owner}@example.test`, name: 'Owner A', role: 'client_admin', passwordHash: hash },
    { id: ids.other, tenantId: ids.b, email: `${ids.other}@example.test`, name: 'Owner B', role: 'client_admin', passwordHash: hash },
  ]);
  await db.insert(bots).values([{ id: ids.botA, tenantId: ids.a, name: 'Bot A', slug: 'bot-a' }, { id: ids.botB, tenantId: ids.b, name: 'Bot B', slug: 'bot-b' }]);
  const token = (id: string, tenantId: string | null, role: 'super_admin' | 'client_admin') => signToken({ sub: id, tenantId, role, email: 'ignored@example.test', name: 'Ignored claims' });
  [adminToken, ownerToken, otherToken] = await Promise.all([token(ids.admin, null, 'super_admin'), token(ids.owner, ids.a, 'client_admin'), token(ids.other, ids.b, 'client_admin')]);
});
afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, createdTenants));
  await db.delete(users).where(eq(users.id, ids.admin));
  await db.delete(adminAuditLogs).where(eq(adminAuditLogs.actorId, ids.admin));
  await db.delete(emailVerifications).where(eq(emailVerifications.email, `${ids.a}-signup@example.test`));
});

describe('admin management and tenant isolation', () => {
  it('applies the additive migration twice without changing legacy accounts', async () => {
    const statements = (await readFile(new URL('../../db/migrations/0011_admin_management.sql', import.meta.url), 'utf8')).split('--> statement-breakpoint');
    await db.transaction(async tx => {
      await tx.execute(sql.raw('CREATE SCHEMA roles_upgrade_fixture'));
      await tx.execute(sql.raw('SET LOCAL search_path TO roles_upgrade_fixture'));
      await tx.execute(sql.raw("CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL, password_hash text); INSERT INTO users VALUES (gen_random_uuid(), 'legacy@example.test', 'existing-hash')"));
      for (let i = 0; i < 2; i++) for (const statement of statements) await tx.execute(sql.raw(statement));
      const rows = await tx.execute(sql.raw('SELECT email, password_hash, username FROM users'));
      expect(rows[0]).toMatchObject({ email: 'legacy@example.test', password_hash: 'existing-hash', username: null });
      await tx.execute(sql.raw('DROP SCHEMA roles_upgrade_fixture CASCADE'));
    });
  });
  it('requires authentication and rejects normal users from admin APIs', async () => {
    expect((await app.request('/api/admin/tenants')).status).toBe(401);
    expect((await request('/admin/tenants', ownerToken)).status).toBe(403);
    expect((await request(`/admin/tenants/${ids.b}/resources`, ownerToken)).status).toBe(403);
  });
  it('uses database role and ownership rather than stale/forged JWT claims', async () => {
    const forged = await signToken({ sub: ids.owner, tenantId: ids.b, role: 'super_admin', email: 'forged@example.test', name: 'Forged' });
    expect((await request('/admin/tenants', forged)).status).toBe(403);
    expect((await request(`/bots/${ids.botB}`, forged)).status).toBe(404);
    expect((await json(await request('/bots', forged))).bots.map((b: any) => b.id)).toEqual([ids.botA]);
  });
  it('blocks tenant overrides and cross-tenant bot reads/writes', async () => {
    expect((await request('/bots', ownerToken, 'GET', undefined, ids.b)).status).toBe(403);
    expect((await request(`/bots/${ids.botB}`, ownerToken)).status).toBe(404);
    expect((await request(`/bots/${ids.botB}`, ownerToken, 'PUT', { name: 'Hacked' })).status).toBe(404);
    expect((await request(`/bots/${ids.botB}`, ownerToken, 'DELETE')).status).toBe(404);
    expect((await request(`/bots/${ids.botB}/conversations`, ownerToken)).status).toBe(404);
  });
  it('requires explicit valid admin scope and opens actual tenant bots without impersonation', async () => {
    expect((await request('/bots')).status).toBe(403);
    expect((await request('/bots', adminToken, 'GET', undefined, 'invalid')).status).toBe(403);
    expect((await request('/bots', adminToken, 'GET', undefined, randomUUID())).status).toBe(404);
    const res = await json(await request(`/bots/${ids.botA}`, adminToken, 'PUT', { name: 'Admin edited real bot' }, ids.a));
    expect(res.bot.id).toBe(ids.botA);
    expect((await json(await request(`/bots/${ids.botA}`, ownerToken))).bot.name).toBe('Admin edited real bot');
    expect((await json(await request('/auth/me'))).user.id).toBe(ids.admin);
    expect((await request(`/bots/${ids.botB}`, adminToken, 'GET', undefined, ids.a)).status).toBe(404);
    await db.update(tenants).set({ featureOverrides: { booking: true } }).where(inArray(tenants.id, [ids.a, ids.b]));
    expect((await request(`/bots/${ids.botB}/booking/settings`, ownerToken)).status).toBe(404);
    expect((await request(`/bots/${ids.botB}/booking/settings`, adminToken, 'GET', undefined, ids.b)).status).toBe(200);
  });
  it('scopes account usage, documents and themes to the selected tenant', async () => {
    await db.update(tenants).set({ tokensUsedThisMonth: 321 }).where(eq(tenants.id, ids.b));
    expect((await json(await request('/account/settings', adminToken, 'GET', undefined, ids.b))).settings.tokensUsedThisMonth).toBe(321);
    expect((await json(await request('/account/settings', ownerToken))).settings.tokensUsedThisMonth).toBe(0);
    const [doc] = await db.insert(botDocuments).values({ botId: ids.botB, tenantId: ids.b, name: 'Secret site', type: 'url', sourceUrl: 'https://example.test', status: 'ready', websiteData: { pages: [] } }).returning();
    expect((await request(`/documents/${doc.id}`, ownerToken, 'PATCH', { name: 'Hacked', url: doc.sourceUrl })).status).toBe(404);
    expect((await request(`/documents/${doc.id}`, adminToken, 'PATCH', { name: 'Admin site', url: doc.sourceUrl }, ids.b)).status).toBe(200);
    expect((await request(`/documents/${doc.id}`, ownerToken, 'DELETE')).status).toBe(404);
    const own = await json(await request(`/documents?botId=${ids.botA}`, ownerToken));
    expect(JSON.stringify(own)).not.toContain(doc.id);
    expect((await request(`/documents?botId=${ids.botB}`, ownerToken)).status).toBe(404);
    const [theme] = await db.insert(tenantThemes).values({ tenantId: ids.b, name: 'Private theme', primaryColor: '#112233', userBubbleColor: '#112233', botBubbleBg: '#ffffff', botTextColor: '#111111', windowBg: '#ffffff', inputBg: '#ffffff' }).returning();
    expect((await request(`/themes/${theme.id}`, ownerToken)).status).toBe(404);
    expect((await request(`/themes/${theme.id}`, ownerToken, 'PUT', { name: 'Hacked' })).status).toBe(404);
    expect((await request(`/themes/${theme.id}`, adminToken, 'PUT', { name: 'Updated theme' }, ids.b)).status).toBe(200);
    expect((await request(`/bots/${ids.botA}`, ownerToken, 'PUT', { tenantThemeId: theme.id })).status).toBe(404);
    expect((await request(`/documents/${doc.id}/rescrape`, adminToken, 'POST', undefined, ids.b)).status).toBe(202);
  });
  it('creates atomic accounts with hashed credentials and supports username and email login', async () => {
    const slug = randomUUID();
    const body = { name: 'Created tenant', slug, plan: 'growth', adminEmail: `${slug}@example.test`, adminUsername: `user-${slug}`, adminName: 'Created owner', adminPassword: 'initial-password-123' };
    const response = await request('/admin/tenants', adminToken, 'POST', body);
    expect(response.status).toBe(201);
    const result = await json(response); createdTenants.push(result.tenant.id);
    expect(result.tenant.monthlyTokenBudget).toBe(4_000_000);
    expect(result.user.passwordHash).toBeUndefined();
    const [saved] = await db.select().from(users).where(eq(users.id, result.user.id));
    expect(saved.passwordHash).not.toBe(body.adminPassword);
    expect(await bcrypt.compare(body.adminPassword, saved.passwordHash!)).toBe(true);
    for (const identifier of [body.adminEmail, body.adminUsername.toUpperCase()]) {
      const login = await json(await request('/auth/login', '', 'POST', { email: identifier, password: body.adminPassword }));
      expect(login.user.id).toBe(saved.id);
      expect((await verifyToken(login.token)).role).toBe('client_admin');
    }
    const duplicate = await request('/admin/tenants', adminToken, 'POST', { ...body, slug: `${slug}-new` });
    expect(duplicate.status).toBe(409);
    expect(await db.select().from(tenants).where(eq(tenants.slug, `${slug}-new`))).toHaveLength(0);
  });
  it('edits users only within their tenant and prevents global role escalation or losing last owner', async () => {
    expect((await request(`/admin/tenants/${ids.a}/users/${ids.other}`, adminToken, 'PATCH', { name: 'Wrong account' })).status).toBe(404);
    expect((await request(`/admin/tenants/${ids.a}/users/${ids.owner}`, adminToken, 'PATCH', { role: 'super_admin' })).status).toBe(400);
    expect((await request(`/admin/tenants/${ids.a}/users/${ids.owner}`, adminToken, 'PATCH', { role: 'client_user' })).status).toBe(409);
    const username = `owner-${ids.owner}`;
    const result = await request(`/admin/tenants/${ids.a}/users/${ids.owner}`, adminToken, 'PATCH', { username, name: 'Renamed owner' });
    expect(result.status).toBe(200);
    expect((await json(await request('/auth/me', ownerToken))).user.name).toBe('Renamed owner');
    const newUser = await json(await request(`/admin/tenants/${ids.a}/users`, adminToken, 'POST', { username: `team-${ids.a}`, email: `team-${ids.a}@example.test`, name: 'Team member', password: 'team-password-123', role: 'client_user' }));
    expect(newUser.user.role).toBe('client_user');
    expect(newUser.user.passwordHash).toBeUndefined();
    const login = await json(await request('/auth/login', '', 'POST', { email: `team-${ids.a}`, password: 'team-password-123' }));
    expect((await request('/account', login.token, 'DELETE')).status).toBe(403);
  });
  it('rolls back the losing account when duplicate credentials race', async () => {
    const suffix = randomUUID();
    const body = { name: 'Race tenant', adminEmail: `race-${suffix}@example.test`, adminUsername: `race-${suffix}`, adminName: 'Race owner', adminPassword: 'race-password-123' };
    const results = await Promise.all([0, 1].map(i => request('/admin/tenants', adminToken, 'POST', { ...body, slug: `race-${suffix}-${i}` })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    for (const response of results) if (response.status === 201) createdTenants.push((await json(response)).tenant.id);
    const created = await db.select().from(tenants).where(inArray(tenants.slug, [`race-${suffix}-0`, `race-${suffix}-1`]));
    expect(created).toHaveLength(1);
  });
  it('keeps legacy password accounts and verified email signup working with nullable username', async () => {
    const login = await json(await request('/auth/login', '', 'POST', { email: `${ids.other}@example.test`, password: 'test-password-123' }));
    expect(login.user.id).toBe(ids.other); expect(login.user.username).toBeNull();
    const email = `${ids.a}-signup@example.test`;
    expect((await request('/auth/register/start', '', 'POST', { email })).status).toBe(200);
    const [verification] = await db.select().from(emailVerifications).where(eq(emailVerifications.email, email));
    const signup = await request('/auth/register/complete', '', 'POST', { token: verification.token, name: 'Signup user', companyName: `Signup ${ids.a}`, password: 'signup-password-123' });
    expect(signup.status).toBe(201);
    const result = await json(signup); createdTenants.push(result.user.tenantId);
    expect((await request('/bots', result.token)).status).toBe(200);
  });
  it('suspension revokes existing JWTs, login and public bots but permits admin management and reactivation', async () => {
    expect((await request(`/admin/tenants/${ids.b}`, adminToken, 'PUT', { status: 'suspended' })).status).toBe(200);
    expect((await request('/bots', otherToken)).status).toBe(403);
    expect((await request('/auth/me', otherToken)).status).toBe(403);
    expect((await request('/auth/login', '', 'POST', { email: `${ids.other}@example.test`, password: 'test-password-123' })).status).toBe(403);
    expect((await app.request(`/api/widget-config/${ids.botB}`)).status).toBe(404);
    expect(await getActiveBot(ids.botB)).toBeUndefined();
    expect((await request(`/bots/${ids.botB}`, adminToken, 'GET', undefined, ids.b)).status).toBe(200);
    await request(`/admin/tenants/${ids.b}`, adminToken, 'PUT', { status: 'active' });
    expect((await request('/bots', otherToken)).status).toBe(200);
    expect((await app.request(`/api/widget-config/${ids.botB}`)).status).toBe(200);
  });
  it('preserves verified Google sign-in, links existing accounts, provisions new ones and blocks disabled accounts', async () => {
    const keys = await generateKeyPair('RS256'); googleFixture.key = keys.publicKey;
    async function callback(email: string, subject: string, verified = true) {
      const idToken = await new SignJWT({ email, email_verified: verified, name: 'Google fixture' })
        .setProtectedHeader({ alg: 'RS256' }).setSubject(subject).setIssuer('https://accounts.google.com')
        .setAudience('roles-test-client').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 })));
      try { return await (await app.request('/api/auth/google/callback?code=test-code&state=test-state')).text(); }
      finally { vi.unstubAllGlobals(); }
    }
    const existing = await callback(`${ids.other}@example.test`, `google-${ids.other}`);
    expect(existing).toContain('"ok":true'); expect(existing).toContain(ids.other);
    const [linked] = await db.select().from(users).where(eq(users.id, ids.other));
    expect(linked.googleId).toBe(`google-${ids.other}`);
    const email = `google-${ids.a}@example.test`;
    const fresh = await callback(email, `google-new-${ids.a}`);
    const [created] = await db.select().from(users).where(eq(users.email, email));
    expect(created.tenantId).toBeTruthy(); createdTenants.push(created.tenantId!);
    expect(created.username).toBeNull(); expect(created.passwordHash).toBeNull();
    expect(fresh).toContain('"isNewAccount":true');
    expect(await callback('unverified@example.test', 'unverified', false)).toContain('email_not_verified');
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, ids.b));
    expect(await callback(`${ids.other}@example.test`, `google-${ids.other}`)).toContain('account_disabled');
    await db.update(tenants).set({ status: 'active' }).where(eq(tenants.id, ids.b));
  });
  it('audits actual admin identities and outcomes without credentials, and lists safe tenant resources', async () => {
    const result = await json(await request(`/admin/tenants/${ids.a}/resources`));
    expect(result.bots.map((b: any) => b.id)).toContain(ids.botA);
    expect(result.audit.some((a: any) => a.actorId === ids.admin && a.resource.endsWith(`/bots/${ids.botA}`) && a.action.includes('succeeded'))).toBe(true);
    expect(result.audit.some((a: any) => a.action.includes('failed'))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|password_hash|initial-password|team-password|Bearer /);
    const listing = await json(await request('/admin/tenants'));
    expect(listing.tenants.find((t: any) => t.id === ids.a).botCount).toBe(1);
  });
  it('revokes deleted accounts immediately and retains deletion audit', async () => {
    await request(`/admin/tenants/${ids.b}`, adminToken, 'DELETE');
    expect((await request('/bots', otherToken)).status).toBe(401);
    const logs = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.tenantId, ids.b));
    expect(logs.some(l => l.action === 'DELETE succeeded (200)')).toBe(true);
  });
});
