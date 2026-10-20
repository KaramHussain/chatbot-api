import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, users, tenants, passwordResetTokens } from '../db/index.js';
import { eq, and, gt } from 'drizzle-orm';
import { signToken, authMiddleware } from '../middleware/auth.js';
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
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const API_PUBLIC_URL = process.env.API_PUBLIC_URL ?? 'http://localhost:3001';
const googleJWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
// Finds or creates a ChatGeniee user from a verified Google identity.
// Same email as an existing account (any signup method) -> that's the same
// person, log them in and silently record the Google link. New email ->
// brand-new signup, auto-provision a tenant with zero blocking steps.
async function upsertUserFromGoogle(email, googleName, googleId) {
    const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existingUser) {
        if (!existingUser.googleId) {
            await db.update(users).set({ googleId, updatedAt: new Date() }).where(eq(users.id, existingUser.id));
        }
        return { user: existingUser, isNewAccount: false };
    }
    const baseSlug = googleName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace';
    let slug = baseSlug;
    const [slugTaken] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (slugTaken)
        slug = `${baseSlug}-${randomBytes(3).toString('hex')}`;
    const [newTenant] = await db.insert(tenants).values({ name: `${googleName}'s Team`, slug }).returning();
    const [newUser] = await db
        .insert(users)
        .values({ tenantId: newTenant.id, email, name: googleName, passwordHash: null, googleId, role: 'client_admin' })
        .returning();
    return { user: newUser, isNewAccount: true };
}
// Renders the tiny page that runs inside the Google sign-in popup once it's
// done — hands the result back to the window that opened it, then closes.
function googleAuthResultPage(payload, targetOrigin) {
    return `<!doctype html><html><body>
<script>
  if (window.opener) {
    window.opener.postMessage(${JSON.stringify({ source: 'chatgeniee-google-auth', ...payload })}, ${JSON.stringify(targetOrigin)});
  }
  window.close();
</script>
</body></html>`;
}
const router = new Hono();
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
    const payload = {
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
// GET /api/auth/google/callback — Google redirects here after the user signs
// in inside a popup window that the dashboard opened itself (so the dashboard
// controls the popup's size/position — Google's own rendered button doesn't
// allow that). This page runs inside that popup: it exchanges the code for
// Google's identity, resolves the ChatGeniee account, then hands the result
// back to the dashboard tab via postMessage and closes itself.
router.get('/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const oauthError = c.req.query('error');
    const origin = new URL(DASHBOARD_URL).origin;
    const fail = (error) => c.html(googleAuthResultPage({ ok: false, error, state }, origin));
    if (oauthError)
        return fail(oauthError);
    if (!code)
        return fail('missing_code');
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)
        return fail('not_configured');
    try {
        const redirectUri = `${API_PUBLIC_URL}/api/auth/google/callback`;
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: GOOGLE_CLIENT_ID,
                client_secret: GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        const tokenJson = (await tokenRes.json());
        if (!tokenRes.ok || !tokenJson.id_token)
            return fail('token_exchange_failed');
        const { payload } = await jwtVerify(tokenJson.id_token, googleJWKS, {
            issuer: ['https://accounts.google.com', 'accounts.google.com'],
            audience: GOOGLE_CLIENT_ID,
        });
        const email = payload.email?.toLowerCase();
        const emailVerified = payload.email_verified === true;
        const googleId = payload.sub;
        const googleName = payload.name?.trim() || email?.split('@')[0] || 'there';
        if (!email || !emailVerified)
            return fail('email_not_verified');
        const { user, isNewAccount } = await upsertUserFromGoogle(email, googleName, googleId);
        const jwtPayload = {
            sub: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            tenantId: user.tenantId,
        };
        const token = await signToken(jwtPayload);
        return c.html(googleAuthResultPage({
            ok: true,
            state,
            token,
            user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId },
            isNewAccount,
        }, origin));
    }
    catch {
        return fail('server_error');
    }
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
    if (!user)
        return c.json({ success: true });
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
    }).catch(() => { });
    return c.json({ success: true });
});
// POST /api/auth/reset-password
router.post('/reset-password', zValidator('json', z.object({
    token: z.string().min(1),
    password: z.string().min(8),
})), async (c) => {
    const { token, password } = c.req.valid('json');
    const [record] = await db.select().from(passwordResetTokens)
        .where(and(eq(passwordResetTokens.token, token), eq(passwordResetTokens.used, false), gt(passwordResetTokens.expiresAt, new Date()))).limit(1);
    if (!record)
        return c.json({ error: 'Invalid or expired reset link' }, 400);
    const hash = await bcrypt.hash(password, 12);
    await db.update(users).set({ passwordHash: hash, updatedAt: new Date() }).where(eq(users.id, record.userId));
    await db.update(passwordResetTokens).set({ used: true }).where(eq(passwordResetTokens.id, record.id));
    return c.json({ success: true });
});
export default router;
//# sourceMappingURL=auth.js.map