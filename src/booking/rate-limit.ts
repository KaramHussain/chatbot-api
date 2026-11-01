// Tiny in-memory sliding-window limiter for public booking endpoints (per process — good enough to blunt
// scripted hold/confirm abuse; the DB constraints and OTP limits are the real guarantees).
const hits = new Map<string, number[]>();

/** Returns true when the call is allowed. */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return false; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return true;
}

export function clientIp(headers: (name: string) => string | undefined): string {
  return (headers('cf-connecting-ip') ?? headers('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}
