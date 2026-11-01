// Time-zone aware helpers. Everything stored is UTC; owner rules are wall-clock in the owner's zone;
// everything shown to a visitor is in the visitor's zone. luxon handles DST correctly.
import { DateTime } from 'luxon';

export const FALLBACK_TZ = 'UTC';

export function isValidTimezone(tz: string | null | undefined): tz is string {
  return !!tz && DateTime.now().setZone(tz).isValid;
}

export function safeTimezone(tz: string | null | undefined, fallback = FALLBACK_TZ): string {
  return isValidTimezone(tz) ? tz : fallback;
}

/** `HH:mm` or `HH:mm:ss` → minutes after midnight. */
export function parseClock(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function toClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The instant a wall-clock time (`YYYY-MM-DD` + `HH:mm`) occurs in a zone. DST gaps move forward. */
export function zonedInstant(date: string, clock: string, zone: string): Date {
  const [h, m] = clock.split(':').map(Number);
  return DateTime.fromISO(date, { zone }).set({ hour: h, minute: m || 0, second: 0, millisecond: 0 }).toJSDate();
}

export function localDate(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

export function localISOWeekday(date: string, zone: string): number {
  return DateTime.fromISO(date, { zone }).weekday;
}

/** Inclusive list of `YYYY-MM-DD` dates between two instants as seen in a zone. */
export function daysBetween(from: Date, to: Date, zone: string): string[] {
  const days: string[] = [];
  let cursor = DateTime.fromJSDate(from, { zone }).startOf('day');
  const end = DateTime.fromJSDate(to, { zone }).startOf('day');
  while (cursor <= end && days.length < 400) {
    days.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

export type TimeFormat = '12h' | '24h';

export function formatTime(instant: Date, zone: string, format: TimeFormat = '12h'): string {
  const dt = DateTime.fromJSDate(instant, { zone });
  return format === '24h' ? dt.toFormat('HH:mm') : dt.toFormat('h:mm a').replace('AM', 'am').replace('PM', 'pm');
}

export function formatDay(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat('ccc d LLL');
}

export function formatDayLong(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat('cccc, d LLLL yyyy');
}

export function formatDateTime(instant: Date, zone: string, format: TimeFormat = '12h'): string {
  return `${formatDay(instant, zone)}, ${formatTime(instant, zone, format)}`;
}

/** "PKT" / "GMT+5" style short zone name for display next to a time. */
export function zoneAbbreviation(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat('ZZZZ');
}

export function partOfDay(instant: Date, zone: string): 'morning' | 'afternoon' | 'evening' {
  const hour = DateTime.fromJSDate(instant, { zone }).hour;
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}
