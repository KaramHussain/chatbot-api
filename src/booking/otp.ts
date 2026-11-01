// Email verification for managing an existing booking. A visitor can only see, move or cancel bookings
// after proving they own the email address with a 6-digit code (10 min, 5 tries, rate-limited).
// The flow never reveals whether a booking exists for an email until the code is verified.
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { bots, conversations, db } from '../db/index.js';
import { BookingError } from './core.js';
import { bookingOtps } from './schema.js';
import { bookingsForEmail } from './service.js';
import { sendOtpEmail } from './notify/notifier.js';
import { hashCode, normalizeEmail, sixDigitCode } from './tokens.js';

const TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const MAX_PER_EMAIL_PER_HOUR = 3;
const MAX_PER_IP_PER_HOUR = 10;

const scope = (botId: string, emailNorm: string) => `${botId}:${emailNorm}`;

/** Always answers `{ sent: true }` (no enumeration); only actually emails when upcoming bookings exist. */
export async function requestOtp(botId: string, email: string, ip?: string): Promise<{ sent: true }> {
  const emailNorm = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailNorm)) throw new BookingError('invalid_input', 'Please give a valid email address.');

  const hourAgo = new Date(Date.now() - 3600_000);
  const [perEmail] = await db.select({ n: sql<number>`count(*)::int` }).from(bookingOtps)
    .where(and(eq(bookingOtps.botId, botId), eq(bookingOtps.emailNorm, emailNorm), gt(bookingOtps.createdAt, hourAgo)));
  if (perEmail.n >= MAX_PER_EMAIL_PER_HOUR) throw new BookingError('rate_limited', 'Too many codes requested. Please try again in an hour.', 429);
  if (ip) {
    const [perIp] = await db.select({ n: sql<number>`count(*)::int` }).from(bookingOtps).where(and(eq(bookingOtps.ip, ip), gt(bookingOtps.createdAt, hourAgo)));
    if (perIp.n >= MAX_PER_IP_PER_HOUR) throw new BookingError('rate_limited', 'Too many requests. Please try again later.', 429);
  }

  if ((await bookingsForEmail(botId, emailNorm)).length === 0) return { sent: true };

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId)).limit(1);
  if (!bot) throw new BookingError('not_found', 'Bot not found.', 404);
  const code = sixDigitCode();
  await db.insert(bookingOtps).values({
    botId, emailNorm, codeHash: hashCode(scope(botId, emailNorm), code), ip: ip ?? null,
    expiresAt: new Date(Date.now() + TTL_MIN * 60_000),
  });
  await sendOtpEmail(bot, email.trim(), code);
  return { sent: true };
}

export async function verifyOtp(botId: string, email: string, code: string): Promise<boolean> {
  const emailNorm = normalizeEmail(email);
  const [row] = await db.select().from(bookingOtps).where(and(
    eq(bookingOtps.botId, botId), eq(bookingOtps.emailNorm, emailNorm), isNull(bookingOtps.consumedAt), gt(bookingOtps.expiresAt, new Date()),
  )).orderBy(desc(bookingOtps.createdAt)).limit(1);
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;

  if (row.codeHash !== hashCode(scope(botId, emailNorm), code.trim())) {
    await db.update(bookingOtps).set({ attempts: row.attempts + 1 }).where(eq(bookingOtps.id, row.id));
    return false;
  }
  await db.update(bookingOtps).set({ consumedAt: new Date() }).where(eq(bookingOtps.id, row.id));
  return true;
}

/** Verify and, on success, unlock manage tools for this one conversation. */
export async function verifyOtpForConversation(botId: string, conversationId: string, email: string, code: string): Promise<boolean> {
  if (!(await verifyOtp(botId, email, code))) return false;
  await db.update(conversations).set({ verifiedEmail: normalizeEmail(email) })
    .where(and(eq(conversations.id, conversationId), eq(conversations.botId, botId)));
  return true;
}

export async function verifiedEmailOf(conversationId: string): Promise<string | null> {
  const [row] = await db.select({ e: conversations.verifiedEmail }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  return row?.e ?? null;
}
