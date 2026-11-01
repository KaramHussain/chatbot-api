// Random bearer tokens (manage links, calendar feed) are stored only as SHA-256 hashes, so a database
// leak can't be used to act on bookings. Approve/decline links are stateless signed links (HMAC) with
// an expiry; they're naturally single-use because a booking can only leave `pending` once.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Hash a one-time code together with its scope, so a code for one email can't verify another. */
export function hashCode(scope: string, code: string): string {
  return createHash('sha256').update(`${scope}:${code}`).digest('hex');
}

const SECRET = () => process.env.API_SECRET ?? 'change-this-to-a-long-random-string';

export type LinkAction = 'approve' | 'decline';

function sign(data: string): string {
  return createHmac('sha256', SECRET()).update(data).digest('base64url');
}

export function signActionToken(bookingId: string, action: LinkAction, ttlHours = 48): string {
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  const data = `${bookingId}.${action}.${exp}`;
  return Buffer.from(`${data}.${sign(data)}`).toString('base64url');
}

export function verifyActionToken(token: string): { bookingId: string; action: LinkAction } | null {
  let decoded: string;
  try { decoded = Buffer.from(token, 'base64url').toString('utf8'); } catch { return null; }
  const parts = decoded.split('.');
  if (parts.length !== 4) return null;
  const [bookingId, action, exp, sig] = parts;
  const expected = sign(`${bookingId}.${action}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  if (action !== 'approve' && action !== 'decline') return null;
  return { bookingId, action };
}

/**
 * Manage links (reschedule / cancel / add to calendar) are stateless signed tokens: `<bookingId>.<mac>`.
 * They can be rebuilt whenever an email is rendered, can't be forged without API_SECRET, and nothing
 * secret is stored. They stop working naturally once a booking is over or cancelled.
 */
export function signManageToken(bookingId: string): string {
  return `${bookingId}.${sign(`manage:${bookingId}`).slice(0, 32)}`;
}

export function verifyManageToken(token: string): string | null {
  const [bookingId, mac, ...rest] = token.split('.');
  if (!bookingId || !mac || rest.length || !/^[0-9a-f-]{36}$/i.test(bookingId)) return null;
  const expected = sign(`manage:${bookingId}`).slice(0, 32);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? bookingId : null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Digits only, keeping a leading country code; good enough to unify the same number typed differently. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  return digits.length >= 6 ? digits : null;
}
