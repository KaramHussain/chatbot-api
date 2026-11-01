// Read models for the owner dashboard: appointment lists, detail, people, and overview statistics.
import { and, asc, desc, eq, gte, ilike, inArray, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { conversations, db, messages } from '../db/index.js';
import { bookingEvents, bookingNotes, bookingPeople, bookings, emailLog, meetingTypes } from './schema.js';
import type { Booking, BookingSettings } from './core.js';
import { safeTimezone } from './time.js';

export type BookingView = 'upcoming' | 'today' | 'pending' | 'past' | 'cancelled' | 'no_show' | 'all';

export interface BookingFilter {
  view?: BookingView;
  q?: string;
  from?: Date;
  to?: Date;
  typeId?: string;
  status?: string[];
  source?: string;
  tag?: string;
  personId?: string;
  sort?: 'start_asc' | 'start_desc' | 'created_desc';
  page?: number;
  pageSize?: number;
}

const HIDDEN = ['held', 'expired'] as const;

/** Raw `sql` templates can't bind a JS Date; send an explicit timestamptz. */
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

function dayBounds(tz: string, now = new Date()) {
  const start = DateTime.fromJSDate(now, { zone: tz }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

export function bookingConditions(botId: string, settings: Pick<BookingSettings, 'timezone'>, f: BookingFilter, now = new Date()): { where: SQL; order: SQL[] } {
  const tz = safeTimezone(settings.timezone);
  const c: Array<SQL | undefined> = [eq(bookings.botId, botId), notInArray(bookings.status, [...HIDDEN])];
  let order: SQL[] = [desc(bookings.startsAt)];

  switch (f.view) {
    case 'upcoming': c.push(inArray(bookings.status, ['confirmed', 'pending']), gte(bookings.startsAt, now)); order = [asc(bookings.startsAt)]; break;
    case 'today': { const d = dayBounds(tz, now); c.push(inArray(bookings.status, ['confirmed', 'pending', 'completed', 'no_show']), gte(bookings.startsAt, d.start), lt(bookings.startsAt, d.end)); order = [asc(bookings.startsAt)]; break; }
    case 'pending': c.push(eq(bookings.status, 'pending')); order = [asc(bookings.startsAt)]; break;
    case 'past': c.push(inArray(bookings.status, ['confirmed', 'completed', 'no_show']), lt(bookings.endsAt, now)); break;
    case 'cancelled': c.push(inArray(bookings.status, ['cancelled', 'declined'])); break;
    case 'no_show': c.push(eq(bookings.status, 'no_show')); break;
    default: break;
  }
  if (f.status?.length) c.push(inArray(bookings.status, f.status as Booking['status'][]));
  if (f.from) c.push(gte(bookings.startsAt, f.from));
  if (f.to) c.push(lt(bookings.startsAt, f.to));
  if (f.typeId) c.push(eq(bookings.meetingTypeId, f.typeId));
  if (f.source) c.push(eq(bookings.source, f.source));
  if (f.personId) c.push(eq(bookings.personId, f.personId));
  if (f.tag) c.push(sql`${f.tag.toLowerCase()} = ANY(${bookings.tags})`);
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_]/g, '\\$&')}%`;
    c.push(or(ilike(bookings.visitorName, like), ilike(bookings.visitorEmail, like), ilike(bookings.visitorPhone, like),
      ilike(bookings.typeName, like), sql`${bookings.answers}::text ILIKE ${like}`));
  }
  if (f.sort === 'start_asc') order = [asc(bookings.startsAt)];
  else if (f.sort === 'start_desc') order = [desc(bookings.startsAt)];
  else if (f.sort === 'created_desc') order = [desc(bookings.createdAt)];
  return { where: and(...c)!, order };
}

export async function listBookings(botId: string, settings: Pick<BookingSettings, 'timezone'>, f: BookingFilter) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const { where, order } = bookingConditions(botId, settings, f);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(bookings).where(where).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(bookings).where(where),
  ]);
  return { rows, total, page, pageSize };
}

/** Counts for the saved-view tabs. */
export async function viewCounts(botId: string, settings: Pick<BookingSettings, 'timezone'>) {
  const now = new Date();
  const d = dayBounds(safeTimezone(settings.timezone), now);
  const [r] = await db.select({
    upcoming: sql<number>`count(*) FILTER (WHERE status IN ('confirmed','pending') AND starts_at >= ${ts(now)})::int`,
    today: sql<number>`count(*) FILTER (WHERE status IN ('confirmed','pending','completed','no_show') AND starts_at >= ${ts(d.start)} AND starts_at < ${ts(d.end)})::int`,
    pending: sql<number>`count(*) FILTER (WHERE status = 'pending')::int`,
    past: sql<number>`count(*) FILTER (WHERE status IN ('confirmed','completed','no_show') AND ends_at < ${ts(now)})::int`,
    cancelled: sql<number>`count(*) FILTER (WHERE status IN ('cancelled','declined'))::int`,
    noShow: sql<number>`count(*) FILTER (WHERE status = 'no_show')::int`,
    all: sql<number>`count(*) FILTER (WHERE status NOT IN ('held','expired'))::int`,
  }).from(bookings).where(eq(bookings.botId, botId));
  return r;
}

export async function getBookingDetail(botId: string, id: string) {
  const [booking] = await db.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.botId, botId))).limit(1);
  if (!booking) return null;

  const [type, person, events, notes, emails, conversation, history] = await Promise.all([
    booking.meetingTypeId ? db.select().from(meetingTypes).where(eq(meetingTypes.id, booking.meetingTypeId)).limit(1).then((r) => r[0] ?? null) : null,
    booking.personId ? db.select().from(bookingPeople).where(eq(bookingPeople.id, booking.personId)).limit(1).then((r) => r[0] ?? null) : null,
    db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, id)).orderBy(asc(bookingEvents.at)),
    db.select().from(bookingNotes).where(eq(bookingNotes.bookingId, id)).orderBy(desc(bookingNotes.createdAt)),
    db.select().from(emailLog).where(eq(emailLog.bookingId, id)).orderBy(desc(emailLog.createdAt)),
    booking.conversationId
      ? db.select({ id: conversations.id, messageCount: conversations.messageCount, startedAt: conversations.startedAt, lastMessageAt: conversations.lastMessageAt })
        .from(conversations).where(eq(conversations.id, booking.conversationId)).limit(1).then((r) => r[0] ?? null)
      : null,
    booking.personId
      ? db.select().from(bookings).where(and(eq(bookings.personId, booking.personId), ne(bookings.id, id), notInArray(bookings.status, [...HIDDEN])))
        .orderBy(desc(bookings.startsAt)).limit(10)
      : [],
  ]);
  return { booking, type, person, events, notes, emails, conversation, history };
}

/** First visitor messages of a conversation — shown as context next to a booking. */
export async function conversationPreview(conversationId: string, limit = 6) {
  return db.select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt)).limit(limit);
}

// ─── People ─────────────────────────────────────────────────────────────────────

/** Folds lead-capture contacts into the people list so owners see everyone in one place. */
export async function syncLeadsToPeople(botId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO booking_people (bot_id, tenant_id, email_norm, name, email, phone, source, first_seen_at, last_seen_at)
    SELECT DISTINCT ON (lower(trim(c.visitor_email))) c.bot_id, c.tenant_id, lower(trim(c.visitor_email)), c.visitor_name,
           trim(c.visitor_email), c.visitor_phone, 'lead', c.started_at, c.last_message_at
    FROM conversations c
    WHERE c.bot_id = ${botId} AND c.visitor_email IS NOT NULL AND trim(c.visitor_email) <> ''
    ORDER BY lower(trim(c.visitor_email)), c.last_message_at DESC
    ON CONFLICT (bot_id, email_norm) WHERE email_norm IS NOT NULL
    DO UPDATE SET last_seen_at = GREATEST(booking_people.last_seen_at, EXCLUDED.last_seen_at),
                  name = COALESCE(booking_people.name, EXCLUDED.name)
  `);
}

export type PeopleSegment = 'new' | 'returning' | 'upcoming' | 'no_show' | 'leads';

export interface PeopleFilter { q?: string; tag?: string; segment?: PeopleSegment; sort?: 'recent' | 'name' | 'bookings'; page?: number; pageSize?: number }

export async function listPeople(botId: string, f: PeopleFilter) {
  await syncLeadsToPeople(botId);
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const like = f.q?.trim() ? `%${f.q.trim().replace(/[%_]/g, '\\$&')}%` : null;

  const base = sql`
    FROM booking_people p
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status IN ('confirmed','pending','completed','no_show'))::int AS total,
             count(*) FILTER (WHERE status = 'no_show')::int AS no_shows,
             min(starts_at) FILTER (WHERE status IN ('confirmed','pending') AND starts_at > now()) AS next_at,
             max(starts_at) FILTER (WHERE status IN ('confirmed','completed','no_show')) AS last_at
      FROM bookings WHERE person_id = p.id
    ) b ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n FROM conversations c
      WHERE c.bot_id = p.bot_id AND p.email_norm IS NOT NULL AND lower(trim(c.visitor_email)) = p.email_norm
    ) cv ON true
    WHERE p.bot_id = ${botId}
      ${like ? sql`AND (p.name ILIKE ${like} OR p.email ILIKE ${like} OR p.phone ILIKE ${like})` : sql``}
      ${f.tag ? sql`AND ${f.tag.toLowerCase()} = ANY(p.tags)` : sql``}
      ${f.segment === 'new' ? sql`AND p.first_seen_at > now() - interval '7 days'` : sql``}
      ${f.segment === 'returning' ? sql`AND COALESCE(b.total, 0) >= 2` : sql``}
      ${f.segment === 'upcoming' ? sql`AND b.next_at IS NOT NULL` : sql``}
      ${f.segment === 'no_show' ? sql`AND COALESCE(b.no_shows, 0) > 0` : sql``}
      ${f.segment === 'leads' ? sql`AND COALESCE(b.total, 0) = 0` : sql``}
  `;
  const order = f.sort === 'name' ? sql`ORDER BY lower(p.name) NULLS LAST` : f.sort === 'bookings' ? sql`ORDER BY COALESCE(b.total,0) DESC, p.last_seen_at DESC` : sql`ORDER BY p.last_seen_at DESC`;

  const [rows, count] = await Promise.all([
    db.execute(sql`
      SELECT p.id, p.name, p.email, p.phone, p.timezone, p.tags, p.source, p.first_seen_at AS "firstSeenAt", p.last_seen_at AS "lastSeenAt",
             COALESCE(b.total, 0) AS "bookingsCount", COALESCE(b.no_shows, 0) AS "noShows", b.next_at AS "nextBookingAt",
             b.last_at AS "lastBookingAt", COALESCE(cv.n, 0) AS "conversationsCount"
      ${base} ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
    db.execute(sql`SELECT count(*)::int AS total ${base}`),
  ]);
  return { rows: rows as unknown as Array<Record<string, unknown>>, total: (count[0] as { total: number }).total, page, pageSize };
}

export async function getPerson(botId: string, id: string) {
  const [person] = await db.select().from(bookingPeople).where(and(eq(bookingPeople.id, id), eq(bookingPeople.botId, botId))).limit(1);
  if (!person) return null;
  const [personBookings, convs, notes] = await Promise.all([
    db.select().from(bookings).where(and(eq(bookings.personId, id), notInArray(bookings.status, [...HIDDEN]))).orderBy(desc(bookings.startsAt)),
    person.emailNorm
      ? db.select({ id: conversations.id, startedAt: conversations.startedAt, lastMessageAt: conversations.lastMessageAt, messageCount: conversations.messageCount })
        .from(conversations).where(and(eq(conversations.botId, botId), sql`lower(trim(${conversations.visitorEmail})) = ${person.emailNorm}`))
        .orderBy(desc(conversations.lastMessageAt)).limit(50)
      : [],
    db.select().from(bookingNotes).where(eq(bookingNotes.personId, id)).orderBy(desc(bookingNotes.createdAt)),
  ]);
  return { person, bookings: personBookings, conversations: convs, notes };
}

/** GDPR-style erase: the person, their notes, bookings and (optionally) their stored conversations. */
export async function deletePerson(botId: string, id: string, opts: { conversations?: boolean } = {}): Promise<boolean> {
  const [person] = await db.select().from(bookingPeople).where(and(eq(bookingPeople.id, id), eq(bookingPeople.botId, botId))).limit(1);
  if (!person) return false;
  await db.transaction(async (tx) => {
    await tx.delete(bookings).where(and(eq(bookings.personId, id), eq(bookings.botId, botId)));
    if (opts.conversations && person.emailNorm) {
      await tx.delete(conversations).where(and(eq(conversations.botId, botId), sql`lower(trim(${conversations.visitorEmail})) = ${person.emailNorm}`));
    }
    await tx.delete(bookingPeople).where(eq(bookingPeople.id, id));
  });
  return true;
}

// ─── Overview statistics ────────────────────────────────────────────────────────

export interface Overview {
  kpis: {
    upcoming: number; today: number; thisMonth: number; booked: number; bookedPrev: number;
    conversations: number; conversion: number | null; showUpRate: number | null; cancellationRate: number | null;
  };
  trend: Array<{ date: string; count: number }>;
  heatmap: Array<{ weekday: number; hour: number; count: number }>;
  sources: Array<{ source: string; count: number }>;
  types: Array<{ type: string; count: number }>;
  nextUp: Booking | null;
  agenda: Booking[];
  attention: { pendingApprovals: number; unmarkedPast: number; failedEmails: number };
  activity: Array<{ id: string; type: string; actor: string; at: Date; bookingId: string; visitorName: string | null; typeName: string | null; data: Record<string, unknown> }>;
}

const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

export async function getOverview(botId: string, settings: Pick<BookingSettings, 'timezone'>, days = 30): Promise<Overview> {
  const tz = safeTimezone(settings.timezone);
  const now = new Date();
  const periodStart = DateTime.fromJSDate(now, { zone: tz }).startOf('day').minus({ days: days - 1 }).toJSDate();
  const prevStart = DateTime.fromJSDate(periodStart, { zone: tz }).minus({ days }).toJSDate();
  const monthStart = DateTime.fromJSDate(now, { zone: tz }).startOf('month').toJSDate();
  const monthEnd = DateTime.fromJSDate(monthStart, { zone: tz }).plus({ months: 1 }).toJSDate();
  const today = dayBounds(tz, now);
  const live = notInArray(bookings.status, ['held', 'expired', 'cancelled', 'declined']);

  const [counts] = await db.select({
    upcoming: sql<number>`count(*) FILTER (WHERE status IN ('confirmed','pending') AND starts_at >= ${ts(now)})::int`,
    today: sql<number>`count(*) FILTER (WHERE status IN ('confirmed','pending','completed','no_show') AND starts_at >= ${ts(today.start)} AND starts_at < ${ts(today.end)})::int`,
    thisMonth: sql<number>`count(*) FILTER (WHERE status NOT IN ('held','expired','cancelled','declined') AND starts_at >= ${ts(monthStart)} AND starts_at < ${ts(monthEnd)})::int`,
    booked: sql<number>`count(*) FILTER (WHERE status NOT IN ('held','expired') AND created_at >= ${ts(periodStart)})::int`,
    bookedPrev: sql<number>`count(*) FILTER (WHERE status NOT IN ('held','expired') AND created_at >= ${ts(prevStart)} AND created_at < ${ts(periodStart)})::int`,
    fromChat: sql<number>`count(*) FILTER (WHERE status NOT IN ('held','expired','cancelled','declined') AND source IN ('chat','voice') AND created_at >= ${ts(periodStart)})::int`,
    cancelled: sql<number>`count(*) FILTER (WHERE status IN ('cancelled') AND created_at >= ${ts(periodStart)})::int`,
    completed: sql<number>`count(*) FILTER (WHERE status = 'completed' AND starts_at >= ${ts(periodStart)})::int`,
    noShows: sql<number>`count(*) FILTER (WHERE status = 'no_show' AND starts_at >= ${ts(periodStart)})::int`,
    pendingApprovals: sql<number>`count(*) FILTER (WHERE status = 'pending')::int`,
    unmarkedPast: sql<number>`count(*) FILTER (WHERE status = 'confirmed' AND ends_at < now() - interval '1 hour' AND ends_at > now() - interval '14 days')::int`,
  }).from(bookings).where(eq(bookings.botId, botId));

  const [convRow] = await db.select({ n: sql<number>`count(*)::int` }).from(conversations)
    .where(and(eq(conversations.botId, botId), gte(conversations.startedAt, periodStart)));

  const [trendRows, heatRows, sourceRows, typeRows, nextUp, agenda, failed, activity] = await Promise.all([
    db.execute(sql`
      SELECT to_char(date_trunc('day', created_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS date, count(*)::int AS count
      FROM bookings WHERE bot_id = ${botId} AND status NOT IN ('held','expired') AND created_at >= ${ts(periodStart)}
      GROUP BY 1 ORDER BY 1`),
    db.execute(sql`
      SELECT extract(isodow FROM starts_at AT TIME ZONE ${tz})::int AS weekday, extract(hour FROM starts_at AT TIME ZONE ${tz})::int AS hour, count(*)::int AS count
      FROM bookings WHERE bot_id = ${botId} AND status NOT IN ('held','expired','cancelled','declined') AND starts_at >= now() - interval '90 days'
      GROUP BY 1, 2`),
    db.execute(sql`SELECT source, count(*)::int AS count FROM bookings WHERE bot_id = ${botId} AND status NOT IN ('held','expired') AND created_at >= ${ts(periodStart)} GROUP BY source ORDER BY 2 DESC`),
    db.execute(sql`SELECT coalesce(type_name, 'Other') AS type, count(*)::int AS count FROM bookings WHERE bot_id = ${botId} AND status NOT IN ('held','expired') AND created_at >= ${ts(periodStart)} GROUP BY 1 ORDER BY 2 DESC`),
    db.select().from(bookings).where(and(eq(bookings.botId, botId), inArray(bookings.status, ['confirmed', 'pending']), gte(bookings.endsAt, now))).orderBy(asc(bookings.startsAt)).limit(1).then((r) => r[0] ?? null),
    db.select().from(bookings).where(and(eq(bookings.botId, botId), live, gte(bookings.startsAt, today.start), lt(bookings.startsAt, today.end))).orderBy(asc(bookings.startsAt)),
    db.select({ n: sql<number>`count(*)::int` }).from(emailLog).where(and(eq(emailLog.botId, botId), eq(emailLog.status, 'failed'), gte(emailLog.createdAt, new Date(now.getTime() - 7 * 86400_000)))),
    db.execute(sql`
      SELECT e.id, e.type, e.actor, e.at, e.booking_id AS "bookingId", e.data, b.visitor_name AS "visitorName", b.type_name AS "typeName"
      FROM booking_events e JOIN bookings b ON b.id = e.booking_id
      WHERE e.bot_id = ${botId} AND e.type <> 'note' ORDER BY e.at DESC LIMIT 12`),
  ]);

  // Fill missing days with zero so the trend chart is continuous.
  const byDay = new Map((trendRows as unknown as Array<{ date: string; count: number }>).map((r) => [r.date, r.count]));
  const trend: Overview['trend'] = [];
  for (let i = 0; i < days; i++) {
    const date = DateTime.fromJSDate(periodStart, { zone: tz }).plus({ days: i }).toISODate()!;
    trend.push({ date, count: byDay.get(date) ?? 0 });
  }

  return {
    kpis: {
      upcoming: counts.upcoming, today: counts.today, thisMonth: counts.thisMonth,
      booked: counts.booked, bookedPrev: counts.bookedPrev, conversations: convRow.n,
      conversion: rate(counts.fromChat, convRow.n), showUpRate: rate(counts.completed, counts.completed + counts.noShows),
      cancellationRate: rate(counts.cancelled, counts.booked),
    },
    trend,
    heatmap: heatRows as unknown as Overview['heatmap'],
    sources: sourceRows as unknown as Overview['sources'],
    types: typeRows as unknown as Overview['types'],
    nextUp,
    agenda,
    attention: { pendingApprovals: counts.pendingApprovals, unmarkedPast: counts.unmarkedPast, failedEmails: failed[0].n },
    activity: activity as unknown as Overview['activity'],
  };
}

/** Calendar feed/grid: every live booking starting in a range. */
export async function bookingsInRange(botId: string, from: Date, to: Date) {
  return db.select().from(bookings).where(and(
    eq(bookings.botId, botId), notInArray(bookings.status, ['held', 'expired', 'declined']), lt(bookings.startsAt, to), gte(bookings.endsAt, from),
  )).orderBy(asc(bookings.startsAt));
}
