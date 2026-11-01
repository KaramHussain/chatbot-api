// The availability engine. PURE — no I/O — so it can be tested exhaustively.
//
//   rules (weekly hours, owner wall-clock) + overrides (per-date) + blocks + existing bookings
//   → the list of start times a visitor may book.
//
// The same engine is used to *offer* slots and to *validate* a chosen slot at hold/confirm time,
// so the AI can never present — and the database can never accept — a time the engine would reject.
import { DateTime } from 'luxon';
import { addMinutes, daysBetween, localDate, localISOWeekday, parseClock, partOfDay, toClock, zonedInstant } from './time.js';

export interface WeeklyRule { weekday: number; start: string; end: string } // weekday 1 = Mon … 7 = Sun
export interface DateOverride { date: string; closed: boolean; ranges: Array<{ start: string; end: string }> }
export interface Interval { start: Date; end: Date }

export interface EngineSettings {
  timezone: string;
  slotIntervalMin: number;
  windowDays: number;
  minNoticeMin: number;
  dailyCap?: number | null;
}

export interface EngineType {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin?: number | null;
  windowDays?: number | null;
  maxPerDay?: number | null;
  slotIntervalMin?: number | null;
}

export interface EngineInput {
  now: Date;
  settings: EngineSettings;
  type: EngineType;
  rules: WeeklyRule[];
  overrides: DateOverride[];
  /** Owner-blocked time (conferences, vacations…). */
  blocks: Interval[];
  /** Buffered ranges of live bookings (held / pending / confirmed) + external calendar busy time. */
  busy: Interval[];
  /** Live bookings per owner-local date, for daily caps. Key: `YYYY-MM-DD`. */
  bookingsPerDay?: Record<string, number>;
  /** Live bookings of THIS meeting type per owner-local date, for the per-type cap. */
  typeBookingsPerDay?: Record<string, number>;
  range: Interval;
}

export interface Slot { start: Date; end: Date }

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** Open wall-clock ranges for one owner-local date: an override replaces the weekly rules. */
export function openRangesFor(
  date: string,
  zone: string,
  rules: WeeklyRule[],
  overrides: DateOverride[],
): Array<{ start: number; end: number }> {
  const override = overrides.find((o) => o.date === date);
  const source = override
    ? override.closed ? [] : override.ranges
    : rules.filter((r) => r.weekday === localISOWeekday(date, zone)).map((r) => ({ start: r.start, end: r.end }));
  return source
    .map((r) => ({ start: parseClock(r.start), end: parseClock(r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
}

export function computeSlots(input: EngineInput): Slot[] {
  const { now, settings, type, rules, overrides, blocks, busy, range } = input;
  const zone = settings.timezone;
  const interval = Math.max(5, type.slotIntervalMin ?? settings.slotIntervalMin);
  const minNotice = type.minNoticeMin ?? settings.minNoticeMin;
  const windowDays = type.windowDays ?? settings.windowDays;
  const earliest = addMinutes(now, minNotice);
  const latest = addMinutes(now, windowDays * 24 * 60);

  const from = new Date(Math.max(range.start.getTime(), earliest.getTime()));
  const to = new Date(Math.min(range.end.getTime(), latest.getTime()));
  if (to <= from) return [];

  const dailyCap = settings.dailyCap ?? null;
  const typeCap = type.maxPerDay ?? null;
  const slots: Slot[] = [];

  for (const date of daysBetween(from, to, zone)) {
    if (dailyCap !== null && (input.bookingsPerDay?.[date] ?? 0) >= dailyCap) continue;
    if (typeCap !== null && (input.typeBookingsPerDay?.[date] ?? 0) >= typeCap) continue;

    for (const open of openRangesFor(date, zone, rules, overrides)) {
      const rangeStart = zonedInstant(date, toClock(open.start), zone);
      const rangeEnd = zonedInstant(date, toClock(open.end), zone);

      for (let start = rangeStart; ; start = addMinutes(start, interval)) {
        const end = addMinutes(start, type.durationMin);
        if (end > rangeEnd) break;
        if (start < from || start > to) continue;
        // The slot, widened by this type's buffers, must not touch any block or live booking.
        const occupied = { start: addMinutes(start, -type.bufferBeforeMin), end: addMinutes(end, type.bufferAfterMin) };
        if (blocks.some((b) => overlaps(occupied, b))) continue;
        if (busy.some((b) => overlaps(occupied, b))) continue;
        slots.push({ start, end });
      }
    }
  }

  // Overlapping ranges could emit the same start twice.
  const seen = new Set<number>();
  return slots
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .filter((s) => !seen.has(s.start.getTime()) && seen.add(s.start.getTime()));
}

/** True when `start` is one of the slots the engine would currently offer. */
export function isSlotOffered(input: Omit<EngineInput, 'range'>, start: Date): boolean {
  const zone = input.settings.timezone;
  const day = DateTime.fromJSDate(start, { zone });
  const range = { start: day.startOf('day').minus({ hours: 1 }).toJSDate(), end: day.endOf('day').plus({ hours: 1 }).toJSDate() };
  return computeSlots({ ...input, range }).some((s) => s.start.getTime() === start.getTime());
}

export interface SlotFilter {
  partOfDay?: 'morning' | 'afternoon' | 'evening';
  /** IANA zone the "part of day" is judged in — the visitor's. */
  zone?: string;
  /** Only slots on this visitor-local weekday (1 = Mon … 7 = Sun). */
  weekday?: number;
}

export function filterSlots(slots: Slot[], filter: SlotFilter): Slot[] {
  const zone = filter.zone ?? 'UTC';
  return slots.filter((s) => {
    if (filter.partOfDay && partOfDay(s.start, zone) !== filter.partOfDay) return false;
    if (filter.weekday && DateTime.fromJSDate(s.start, { zone }).weekday !== filter.weekday) return false;
    return true;
  });
}

/**
 * A short, well-spread selection to show first: up to `days` dates (visitor-local), up to `perDay`
 * times each, evenly spread through the day rather than the first N (which would all be 9am).
 */
export function suggestSlots(slots: Slot[], zone: string, days = 3, perDay = 3): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) {
    const key = localDate(s.start, zone);
    if (!byDay.has(key) && byDay.size >= days) continue;
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(s);
  }
  const picked: Slot[] = [];
  for (const list of byDay.values()) {
    if (list.length <= perDay) { picked.push(...list); continue; }
    for (let i = 0; i < perDay; i++) picked.push(list[Math.round((i * (list.length - 1)) / (perDay - 1))]);
  }
  return picked;
}
