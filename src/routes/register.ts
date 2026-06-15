import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, users, tenants, emailVerifications } from '../db/index.js';
import { eq, and, gt } from 'drizzle-orm';
import { signToken } from '../middleware/auth.js';
import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
import type { JwtPayload } from '../types/index.js';

const router = new Hono();

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'https://chat.cloudgeniee.com';

// POST /api/auth/register/start — step 1: validate email and send verification link
router.post('/start', zValidator('json', z.object({ email: z.string().email() })), async (c) => {
  const { email } = c.req.valid('json');
  const normalised = email.toLowerCase().trim();

  // Check if email already has an account
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalised))
    .limit(1);

  if (existing) {
    return c.json({ error: 'An account with this email already exists. Please log in.' }, 409);
  }

  // Invalidate any prior unused tokens for this email
  await db
    .update(emailVerifications)
    .set({ used: true })
    .where(and(eq(emailVerifications.email, normalised), eq(emailVerifications.used, false)));

  // Create new token — 32 random bytes = 64 hex chars
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.insert(emailVerifications).values({ token, email: normalised, expiresAt });

  const verifyUrl = `${DASHBOARD_URL}/register/complete/${token}`;

  await mailer.sendMail({
    from: `"CloudGeniee" <${process.env.SMTP_USER}>`,
    to: normalised,
    subject: 'Verify your email — CloudGeniee',
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;">
        <div style="margin-bottom:32px;">
          <h1 style="font-size:24px;font-weight:700;color:#111;margin:0 0 8px;">Verify your email</h1>
          <p style="color:#6b7280;font-size:15px;line-height:1.6;margin:0;">
            Click the button below to create your CloudGeniee account. This link expires in <strong>1 hour</strong>.
          </p>
        </div>
        <a href="${verifyUrl}" style="display:inline-block;padding:14px 28px;background:#000;color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600;letter-spacing:-0.01em;">
          Create my account →
        </a>
        <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e7eb;">
          <p style="color:#9ca3af;font-size:13px;margin:0;">
            If you didn't request this, you can safely ignore this email.<br>
            Or copy this link: <a href="${verifyUrl}" style="color:#6b7280;">${verifyUrl}</a>
          </p>
        </div>
      </div>
    `,
  });

  return c.json({ success: true, message: 'Verification email sent' });
});

// GET /api/auth/register/verify/:token — step 2: validate token (called on page load)
router.get('/verify/:token', async (c) => {
  const { token } = c.req.param();

  const [record] = await db
    .select()
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.token, token),
        eq(emailVerifications.used, false),
        gt(emailVerifications.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!record) {
    return c.json({ error: 'This link is invalid or has expired. Please request a new one.' }, 400);
  }

  return c.json({ email: record.email, valid: true });
});

// POST /api/auth/register/complete — step 3: finish registration
const completeSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(2).max(100),
  companyName: z.string().min(2).max(100),
  password: z.string().min(8).max(128),
});

router.post('/complete', zValidator('json', completeSchema), async (c) => {
  const { token, name, companyName, password } = c.req.valid('json');

  // Re-validate token
  const [record] = await db
    .select()
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.token, token),
        eq(emailVerifications.used, false),
        gt(emailVerifications.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!record) {
    return c.json({ error: 'This link is invalid or has expired. Please request a new one.' }, 400);
  }

  // Double-check email not taken (race condition)
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, record.email))
    .limit(1);

  if (taken) {
    return c.json({ error: 'An account with this email already exists.' }, 409);
  }

  // Generate tenant slug from company name
  const baseSlug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  // Make slug unique by appending a short suffix if needed
  let slug = baseSlug;
  const [slugTaken] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);

  if (slugTaken) {
    slug = `${baseSlug}-${randomBytes(3).toString('hex')}`;
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 12);

  // Create tenant + user in a transaction
  const [newTenant] = await db
    .insert(tenants)
    .values({ name: companyName, slug })
    .returning();

  const [newUser] = await db
    .insert(users)
    .values({
      tenantId: newTenant.id,
      email: record.email,
      name,
      passwordHash,
      role: 'client_admin',
    })
    .returning();

  // Mark token as used
  await db
    .update(emailVerifications)
    .set({ used: true })
    .where(eq(emailVerifications.id, record.id));

  // Issue JWT and log them straight in
  const payload: JwtPayload = {
    sub: newUser.id,
    email: newUser.email,
    name: newUser.name,
    role: newUser.role,
    tenantId: newUser.tenantId,
  };

  const jwtToken = await signToken(payload);

  return c.json({
    token: jwtToken,
    user: {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      role: newUser.role,
      tenantId: newUser.tenantId,
    },
  }, 201);
});

export default router;
