import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { jwtVerify, SignJWT } from 'jose';
import type { HonoEnv, JwtPayload } from '../types/index.js';
import { db, users, tenants, adminAuditLogs } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

export async function tenantIsActive(tenantId: string | null): Promise<boolean> {
  if (!tenantId) return false;
  const [tenant] = await db.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId));
  return tenant?.status === 'active';
}

const JWT_SECRET = new TextEncoder().encode(
  process.env.API_SECRET ?? 'change-this-to-a-long-random-string'
);

export const JWT_EXPIRY = '24h';

// Create a signed JWT for a user (called on login)
export async function signToken(payload: JwtPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .sign(JWT_SECRET);
}

// Verify a JWT and return the payload
export async function verifyToken(token: string): Promise<JwtPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  return payload as unknown as JwtPayload;
}

// Middleware: require valid JWT in Authorization header
export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing authorization header' });
  }

  const token = authHeader.slice(7);

  let payload: JwtPayload;
  try {
    payload = await verifyToken(token);
  } catch {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  if (!z.string().uuid().safeParse(payload.sub).success) throw new HTTPException(401, { message: 'Invalid account' });
  // Database authority revokes deleted users, changed roles and disabled tenants immediately.
  const [authUser] = await db.select({ id: users.id, email: users.email, username: users.username,
    name: users.name, role: users.role, tenantId: users.tenantId }).from(users).where(eq(users.id, payload.sub));
  if (!authUser) throw new HTTPException(401, { message: 'Account no longer available' });
  if (authUser.role !== 'super_admin' && !(await tenantIsActive(authUser.tenantId))) {
    throw new HTTPException(403, { message: 'Your account is disabled. Please contact support.' });
  }

  c.set('user', authUser);
  await next();
});

// Guard: only super_admin
export const requireSuperAdmin = createMiddleware<HonoEnv>(async (c, next) => {
  const user = c.get('user');
  if (user.role !== 'super_admin') {
    throw new HTTPException(403, { message: 'Forbidden' });
  }
  await next();
});

// Guard: user must belong to a tenant
export const requireTenant = createMiddleware<HonoEnv>(async (c, next) => {
  const user = c.get('user');
  const selected = c.req.header('X-Tenant-ID');
  if (selected && user.role !== 'super_admin') {
    throw new HTTPException(403, { message: 'Only administrators may select another account' });
  }
  const tenantId = user.role === 'super_admin' ? selected : user.tenantId;
  if (!tenantId || !z.string().uuid().safeParse(tenantId).success) {
    throw new HTTPException(403, { message: 'Select a tenant to manage first' });
  }
  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new HTTPException(404, { message: 'Tenant not found' });
  c.set('tenantId', tenantId);
  await next();
});

// Persist an attempt before mutation, then its outcome. Never log request bodies or credentials.
export const auditAdminActions = createMiddleware<HonoEnv>(async (c, next) => {
  if (c.get('user').role !== 'super_admin' || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
  const path = new URL(c.req.url).pathname;
  const match = path.match(/\/admin\/tenants\/([0-9a-f-]{36})(?:\/|$)/i);
  const candidate = match?.[1] ?? c.req.header('X-Tenant-ID');
  const tenantId = z.string().uuid().safeParse(candidate).success ? candidate! : null;
  const [entry] = await db.insert(adminAuditLogs).values({ actorId: c.get('user').id,
    tenantId, action: `${c.req.method} attempted`, resource: path }).returning({ id: adminAuditLogs.id });
  await next();
  await db.update(adminAuditLogs).set({ tenantId: c.get('tenantId') ?? tenantId,
    action: `${c.req.method} ${c.res.status < 400 ? 'succeeded' : 'failed'} (${c.res.status})` })
    .where(eq(adminAuditLogs.id, entry.id));
});
