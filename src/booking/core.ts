// Shared plumbing for the booking modules: errors, settings, and loading everything the pure
// availability engine needs from the database.
import { and, asc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  availabilityBlocks, availabilityOverrides, availabilityRules, bookings, bookingSettings, meetingTypes,
} from './schema.js';
import type { EngineInput } from './availability.js';
import { addMinutes, localDate, safeTimezone } from './time.js';

export type BookingSettings = typeof bookingSettings.$inferSelect;
export type MeetingType = typeof meetingTypes.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

export type BookingErrorCode =
  | 'slot_taken' | 'slot_unavailable' | 'hold_expired' | 'not_found' | 'invalid_state'
  | 'missing_fields' | 'invalid_input' | 'disabled' | 'paused' | 'forbidden' | 'rate_limited';

export class BookingError extends Error {
  constructor(public code: BookingErrorCode, message: string, public status = 400) {
    super(message);
    this.name = 'BookingError';
  }
}

/** Postgres exclusion-constraint violation = someone else holds/booked that time. */
export function isOverlapViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === '23P01' || e?.cause?.code === '23P01';
}

export const HOLD_MINUTES = 10;
export const LIVE_STATUSES = ['held', 'pending', 'confirmed'] as const;

export async function getSettings(botId: string): Promise<BookingSettings | undefined> {
  const [row] = await db.select().from(bookingSettings).where(eq(bookingSettings.botId, botId)).limit(1);
  return row;
}

/** Settings row for a bot, created with defaults on first use. */
export async function ensureSettings(bot: { id: string; tenantId: string }): Promise<BookingSettings> {
  const existing = await getSettings(bot.id);
  if (existing) return existing;
  await db.insert(bookingSettings).values({ botId: bot.id, tenantId: bot.tenantId }).onConflictDoNothing();
  return (await getSettings(bot.id))!;
}

export async function getMeetingType(botId: string, typeId: string): Promise<MeetingType | undefined> {
  const [row] = await db
    .select()
    .from(meetingTypes)
    .where(and(eq(meetingTypes.id, typeId), eq(meetingTypes.botId, botId)))
    .limit(1);
  return row;
}

export async function listActiveTypes(botId: string): Promise<MeetingType[]> {
  return db
    .select()
    .from(meetingTypes)
    .where(and(eq(meetingTypes.botId, botId), eq(meetingTypes.active, true)))
    .orderBy(asc(meetingTypes.sort), asc(meetingTypes.createdAt));
}

/** The booking's occupied range: its slot widened by the type's buffers. */
export function blockRange(start: Date, end: Date, type: Pick<MeetingType, 'bufferBeforeMin' | 'bufferAfterMin'>) {
  return { blockStartsAt: addMinutes(start, -type.bufferBeforeMin), blockEndsAt: addMinutes(end, type.bufferAfterMin) };
}

const pad36h = 36 * 60;

/**
 * Everything the engine needs for [from, to]. `excludeBookingId` lets a booking being moved ignore
 * its own current occupancy.
 */
export async function loadEngineContext(
  settings: BookingSettings,
  type: MeetingType,
  from: Date,
  to: Date,
  opts: { now?: Date; excludeBookingId?: string; client?: DbOrTx; ignoreNotice?: boolean } = {},
): Promise<Omit<EngineInput, 'range'>> {
  const now = opts.now ?? new Date();
  const q = opts.client ?? db;
  const zone = safeTimezone(settings.timezone);
  const wideFrom = addMinutes(from, -pad36h);
  const wideTo = addMinutes(to, pad36h);

  const [rules, overrides, blocks, live] = await Promise.all([
    q.select().from(availabilityRules).where(eq(availabilityRules.botId, settings.botId)),
    q.select().from(availabilityOverrides).where(eq(availabilityOverrides.botId, settings.botId)),
    q.select().from(availabilityBlocks).where(and(
      eq(availabilityBlocks.botId, settings.botId),
      lt(availabilityBlocks.startsAt, wideTo),
      gt(availabilityBlocks.endsAt, wideFrom),
    )),
    q.select().from(bookings).where(and(
      eq(bookings.botId, settings.botId),
      inArray(bookings.status, [...LIVE_STATUSES]),
      lt(bookings.blockStartsAt, wideTo),
      gt(bookings.blockEndsAt, wideFrom),
      opts.excludeBookingId ? ne(bookings.id, opts.excludeBookingId) : undefined,
    )),
  ]);

  // An expired hold no longer occupies its slot (the worker flips it to `expired` shortly after).
  const active = live.filter((b) => b.status !== 'held' || (b.holdExpiresAt && b.holdExpiresAt > now));
  const bookingsPerDay: Record<string, number> = {};
  const typeBookingsPerDay: Record<string, number> = {};
  for (const b of active) {
    const day = localDate(b.startsAt, zone);
    bookingsPerDay[day] = (bookingsPerDay[day] ?? 0) + 1;
    if (b.meetingTypeId === type.id) typeBookingsPerDay[day] = (typeBookingsPerDay[day] ?? 0) + 1;
  }

  return {
    now,
    settings: {
      timezone: zone,
      slotIntervalMin: settings.slotIntervalMin,
      windowDays: settings.windowDays,
      minNoticeMin: opts.ignoreNotice ? 0 : settings.minNoticeMin,
      dailyCap: settings.dailyCap,
    },
    type: {
      durationMin: type.durationMin,
      bufferBeforeMin: type.bufferBeforeMin,
      bufferAfterMin: type.bufferAfterMin,
      minNoticeMin: opts.ignoreNotice ? 0 : type.minNoticeMin,
      windowDays: type.windowDays,
      maxPerDay: type.maxPerDay,
      slotIntervalMin: type.slotIntervalMin,
    },
    rules: rules.map((r) => ({ weekday: r.weekday, start: r.startTime.slice(0, 5), end: r.endTime.slice(0, 5) })),
    overrides: overrides.map((o) => ({ date: String(o.date), closed: o.closed, ranges: o.ranges })),
    blocks: blocks.map((b) => ({ start: b.startsAt, end: b.endsAt })),
    busy: active.map((b) => ({ start: b.blockStartsAt, end: b.blockEndsAt })),
    bookingsPerDay,
    typeBookingsPerDay,
  };
}

/** Frees holds whose time ran out. Cheap; called before every hold/slot search for correctness. */
export async function expireStaleHolds(botId?: string, client: DbOrTx = db): Promise<number> {
  const res = await client
    .update(bookings)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(
      eq(bookings.status, 'held'),
      lt(bookings.holdExpiresAt, new Date()),
      botId ? eq(bookings.botId, botId) : undefined,
    ))
    .returning({ id: bookings.id });
  return res.length;
}

export const nowSql = sql`now()`;
