// Fixtures for integration tests. Refuses to run against anything but the local Docker test database.
import { DateTime } from 'luxon';
import { bots, db, tenants, users } from '../db/index.js';
import { availabilityRules, bookingSettings, meetingTypes } from './schema.js';

if (!process.env.DATABASE_URL?.includes('localhost:55432')) {
  throw new Error('Booking tests must run against the Docker test database (localhost:55432).');
}

export async function seedBot(opts: { plan?: 'starter' | 'growth' | 'enterprise'; confirmation?: 'instant' | 'approval'; tz?: string; questions?: unknown[] } = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [tenant] = await db.insert(tenants).values({ name: `Acme ${suffix}`, slug: `acme-${suffix}`, plan: opts.plan ?? 'growth' }).returning();
  await db.insert(users).values({ tenantId: tenant.id, email: `owner-${suffix}@acme.test`, name: 'Owner', role: 'client_admin', passwordHash: 'x' } as never);
  const [bot] = await db.insert(bots).values({ tenantId: tenant.id, name: `Acme Dental ${suffix}`, slug: `acme-dental-${suffix}` }).returning();
  const tz = opts.tz ?? 'UTC';
  await db.insert(bookingSettings).values({
    botId: bot.id, tenantId: tenant.id, enabled: true, timezone: tz, minNoticeMin: 0, slotIntervalMin: 30, windowDays: 60,
  });
  await db.insert(availabilityRules).values([1, 2, 3, 4, 5].map((weekday) => ({
    botId: bot.id, tenantId: tenant.id, weekday, startTime: '09:00', endTime: '17:00',
  })));
  const [type] = await db.insert(meetingTypes).values({
    botId: bot.id, tenantId: tenant.id, name: 'Consultation', slug: 'consultation', durationMin: 30,
    locationType: 'link', locationValue: 'https://meet.example.com/abc', confirmation: opts.confirmation ?? 'instant',
    questions: (opts.questions ?? []) as never,
  }).returning();
  return { tenant, bot, type, suffix, ownerEmail: `owner-${suffix}@acme.test` };
}

/** A future weekday slot start: `daysAhead` days from now at `hour:minute` in zone, moved to Mon–Fri. */
export function futureSlot(hour = 10, minute = 0, daysAhead = 7, zone = 'UTC'): Date {
  let d = DateTime.now().setZone(zone).plus({ days: daysAhead }).set({ hour, minute, second: 0, millisecond: 0 });
  while (d.weekday > 5) d = d.plus({ days: 1 });
  return d.toJSDate();
}
