import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, users, tenants, passwordResetTokens } from '../db/index.js';
import { eq, and, gt } from 'drizzle-orm';
import { signToken, authMiddleware } from '../middleware/auth.js';
import type { HonoEnv, JwtPayload } from '../types/index.js';
import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'https://chat.cloudgeniee.com';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleJWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const router = new Hono<HonoEnv>();

// POST /api/auth/login
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user || !user.passwordHash) {
    // Prevent timing attacks — always run bcrypt even on missing user / Google-only account
    await bcrypt.compare(password, '$2b$10$invalidhashtopreventtimingattack');
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
  };

  const token = await signToken(payload);

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    },
  });
});

// POST /api/auth/google — sign in or sign up with a Google ID token.
//
// Account-linking logic:
//   1. Verify the token is really from Google and the email is Google-verified.
//   2. Look up the user by that email, regardless of how they originally signed up.
//      - Found  -> same person, log them in (and silently record the Google link
//                  if this is the first time they've used Google on this account).
//      - Not found -> brand-new signup. Auto-provision a tenant so there's zero
//                  friction (name defaults from their Google profile; they can
//                  rename it later in Settings — nothing blocks them getting in).
router.post('/google', zValidator('json', z.object({ credential: z.string().min(1) })), async (c) => {
  if (!GOOGLE_CLIENT_ID) {
    return c.json({ error: 'Google sign-in is not configured on this server' }, 500);
  }

  const { credential } = c.req.valid('json');

  let payload;
  try {
    ({ payload } = await jwtVerify(credential, googleJWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: GOOGLE_CLIENT_ID,
    }));
  } catch {
    return c.json({ error: 'Invalid or expired Google credential' }, 401);
  }

  const email = (payload.email as string | undefined)?.toLowerCase();
  const emailVerified = payload.email_verified === true;
  const googleId = payload.sub as string;
  const googleName = (payload.name as string | undefined)?.trim() || email?.split('@')[0] || 'there';

  if (!email || !emailVerified) {
    return c.json({ error: 'Your Google account email must be verified to sign in' }, 401);
  }

  const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let user = existingUser;

  if (user) {
    // Same verified email as an existing account — link Google to it (first time only).
    if (!user.googleId) {
      await db.update(users).set({ googleId, updatedAt: new Date() }).where(eq(users.id, user.id));
    }
  } else {
    // Brand-new signup via Google. Auto-create a tenant — no blocking "fill this in" step.
    const baseSlug = googleName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace';

    let slug = baseSlug;
    const [slugTaken] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (slugTaken) slug = `${baseSlug}-${randomBytes(3).toString('hex')}`;

    const [newTenant] = await db
      .insert(tenants)
      .values({ name: `${googleName}'s Team`, slug })
      .returning();

    const [newUser] = await db
      .insert(users)
      .values({
        tenantId: newTenant.id,
        email,
        name: googleName,
        passwordHash: null,
        googleId,
        role: 'client_admin',
      })
      .returning();

    user = newUser;
  }

  const jwtPayload: JwtPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
  };

  const token = await signToken(jwtPayload);

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    },
    isNewAccount: !existingUser,
  });
});

// POST /api/auth/me — verify token and return current user
router.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  return c.json({ user });
});

// POST /api/auth/change-password — authenticated users change their own password
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post('/change-password', authMiddleware, zValidator('json', changePasswordSchema), async (c) => {
  const authUser = c.get('user');
  const { currentPassword, newPassword } = c.req.valid('json');

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, authUser.id))
    .limit(1);

  if (!user.passwordHash) {
    return c.json({ error: 'This account signed up with Google and has no password to change' }, 400);
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    return c.json({ error: 'Current password is incorrect' }, 400);
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash: newHash, updatedAt: new Date() })
    .where(eq(users.id, authUser.id));

  return c.json({ success: true });
});

// POST /api/auth/forgot-password — send reset link
router.post('/forgot-password', zValidator('json', z.object({ email: z.string().email() })), async (c) => {
  const { email } = c.req.valid('json');

  const [user] = await db.select({ id: users.id, name: users.name }).from(users)
    .where(eq(users.email, email.toLowerCase())).limit(1);

  // Always return success to prevent email enumeration
  if (!user) return c.json({ success: true });

  // Invalidate old tokens for this user
  await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.id));

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  await db.insert(passwordResetTokens).values({ userId: user.id, token, expiresAt });

  const resetUrl = `${DASHBOARD_URL}/reset-password?token=${token}`;

  await mailer.sendMail({
    from: process.env.SMTP_FROM ?? 'CloudGeniee <cloudgeniee@gmail.com>',
    to: email,
    subject: 'Reset your CloudGeniee password',
    html: `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
        <h2 style="font-size:24px;font-weight:700;margin-bottom:8px">Reset your password</h2>
        <p style="color:#6b7280;margin-bottom:32px">Click the button below to set a new password. This link expires in 24 hours.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#000;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">Reset Password</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:32px">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  }).catch(() => {});

  return c.json({ success: true });
});

// POST /api/auth/reset-password
router.post('/reset-password', zValidator('json', z.object({
  token: z.string().min(1),
  password: z.string().min(8),
})), async (c) => {
  const { token, password } = c.req.valid('json');

  const [record] = await db.select().from(passwordResetTokens)
    .where(and(
      eq(passwordResetTokens.token, token),
      eq(passwordResetTokens.used, false),
      gt(passwordResetTokens.expiresAt, new Date()),
    )).limit(1);

  if (!record) return c.json({ error: 'Invalid or expired reset link' }, 400);

  const hash = await bcrypt.hash(password, 12);
  await db.update(users).set({ passwordHash: hash, updatedAt: new Date() }).where(eq(users.id, record.userId));
  await db.update(passwordResetTokens).set({ used: true }).where(eq(passwordResetTokens.id, record.id));

  return c.json({ success: true });
});

export default router;
