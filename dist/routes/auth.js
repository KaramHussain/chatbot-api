import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, users, passwordResetTokens } from '../db/index.js';
import { eq, and, gt } from 'drizzle-orm';
import { signToken, authMiddleware } from '../middleware/auth.js';
import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';
import bcrypt from 'bcryptjs';
const mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
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
    if (!user) {
        // Prevent timing attacks — always run bcrypt even on missing user
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
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await db.insert(passwordResetTokens).values({ userId: user.id, token, expiresAt });
    const resetUrl = `${DASHBOARD_URL}/reset-password/${token}`;
    await mailer.sendMail({
        from: process.env.SMTP_FROM ?? 'CloudGeniee <cloudgeniee@gmail.com>',
        to: email,
        subject: 'Reset your CloudGeniee password',
        html: `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
        <h2 style="font-size:24px;font-weight:700;margin-bottom:8px">Reset your password</h2>
        <p style="color:#6b7280;margin-bottom:32px">Click the button below to set a new password. This link expires in 1 hour.</p>
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