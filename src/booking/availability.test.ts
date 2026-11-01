import { describe, expect, it } from 'vitest';
import { computeSlots, filterSlots, isSlotOffered, suggestSlots, type EngineInput } from './availability.js';
import { formatTime, localDate } from './time.js';

const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));

function input(over: Partial<EngineInput> = {}): EngineInput {
  return {
    now: new Date('2026-11-02T00:00:00Z'), // Monday
    settings: { timezone: 'UTC', slotIntervalMin: 30, windowDays: 60, minNoticeMin: 0 },
    type: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0 },
    rules: weekdays,
    overrides: [],
    blocks: [],
    busy: [],
    range: { start: new Date('2026-11-03T00:00:00Z'), end: new Date('2026-11-03T23:59:59Z') }, // Tuesday
    ...over,
  };
}
const times = (slots: { start: Date }[], zone = 'UTC') => slots.map((s) => formatTime(s.start, zone, '24h'));

describe('computeSlots', () => {
  it('generates every interval inside working hours', () => {
    const t = times(computeSlots(input()));
    expect(t[0]).toBe('09:00');
    expect(t.at(-1)).toBe('16:30');
    expect(t).toHaveLength(16);
  });

  it('returns nothing on days without rules (weekend)', () => {
    const r = { start: new Date('2026-11-07T00:00:00Z'), end: new Date('2026-11-08T23:59:59Z') };
    expect(computeSlots(input({ range: r }))).toHaveLength(0);
  });

  it('respects minimum notice', () => {
    const slots = computeSlots(input({
      now: new Date('2026-11-03T08:00:00Z'),
      settings: { timezone: 'UTC', slotIntervalMin: 30, windowDays: 60, minNoticeMin: 120 },
    }));
    expect(times(slots)[0]).toBe('10:00');
  });

  it('respects the booking window', () => {
    const slots = computeSlots(input({
      settings: { timezone: 'UTC', slotIntervalMin: 30, windowDays: 1, minNoticeMin: 0 },
      range: { start: new Date('2026-11-02T00:00:00Z'), end: new Date('2026-11-10T00:00:00Z') },
    }));
    // now = Mon 00:00, window 1 day → nothing after Tue 00:00 (Monday's hours only)
    expect(new Set(slots.map((s) => localDate(s.start, 'UTC')))).toEqual(new Set(['2026-11-02']));
  });

  it('removes slots overlapping a live booking, including its buffers', () => {
    const busy = [{ start: new Date('2026-11-03T10:00:00Z'), end: new Date('2026-11-03T11:00:00Z') }];
    const t = times(computeSlots(input({ busy })));
    expect(t).not.toContain('10:00');
    expect(t).not.toContain('10:30');
    expect(t).toContain('09:30');
    expect(t).toContain('11:00');

    const buffered = times(computeSlots(input({ busy, type: { durationMin: 30, bufferBeforeMin: 15, bufferAfterMin: 15 } })));
    expect(buffered).not.toContain('09:30'); // 09:30–10:00 + 15 min after touches the booking
    expect(buffered).not.toContain('11:00'); // 15 min buffer before overlaps 11:00 start? 10:45–11:45 vs busy end 11:00
    expect(buffered).toContain('11:30');
  });

  it('removes slots inside owner blocks', () => {
    const blocks = [{ start: new Date('2026-11-03T13:00:00Z'), end: new Date('2026-11-03T15:00:00Z') }];
    const t = times(computeSlots(input({ blocks })));
    expect(t).not.toContain('13:00');
    expect(t).not.toContain('14:30');
    expect(t).toContain('15:00');
    expect(t).toContain('12:30');
  });

  it('closed date overrides remove the whole day', () => {
    const overrides = [{ date: '2026-11-03', closed: true, ranges: [] }];
    expect(computeSlots(input({ overrides }))).toHaveLength(0);
  });

  it('special-hours overrides replace the weekly rule', () => {
    const overrides = [{ date: '2026-11-03', closed: false, ranges: [{ start: '12:00', end: '14:00' }] }];
    expect(times(computeSlots(input({ overrides })))).toEqual(['12:00', '12:30', '13:00', '13:30']);
  });

  it('supports split days (lunch break)', () => {
    const rules = [{ weekday: 2, start: '09:00', end: '11:00' }, { weekday: 2, start: '14:00', end: '15:00' }];
    expect(times(computeSlots(input({ rules })))).toEqual(['09:00', '09:30', '10:00', '10:30', '14:00', '14:30']);
  });

  it('long meetings do not run past closing time', () => {
    const t = times(computeSlots(input({ type: { durationMin: 90, bufferBeforeMin: 0, bufferAfterMin: 0 } })));
    expect(t.at(-1)).toBe('15:30');
  });

  it('enforces the daily cap and per-type cap', () => {
    expect(computeSlots(input({ settings: { timezone: 'UTC', slotIntervalMin: 30, windowDays: 60, minNoticeMin: 0, dailyCap: 3 }, bookingsPerDay: { '2026-11-03': 3 } }))).toHaveLength(0);
    expect(computeSlots(input({ settings: { timezone: 'UTC', slotIntervalMin: 30, windowDays: 60, minNoticeMin: 0, dailyCap: 3 }, bookingsPerDay: { '2026-11-03': 2 } }))).toHaveLength(16);
    expect(computeSlots(input({ type: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, maxPerDay: 1 }, typeBookingsPerDay: { '2026-11-03': 1 } }))).toHaveLength(0);
  });

  it('type slot interval overrides the default', () => {
    const t = times(computeSlots(input({ type: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, slotIntervalMin: 60 } })));
    expect(t.slice(0, 3)).toEqual(['09:00', '10:00', '11:00']);
  });

  it('interprets rules in the owner timezone and converts for a visitor', () => {
    const slots = computeSlots(input({
      settings: { timezone: 'Asia/Karachi', slotIntervalMin: 30, windowDays: 60, minNoticeMin: 0 }, // UTC+5
      range: { start: new Date('2026-11-02T20:00:00Z'), end: new Date('2026-11-03T20:00:00Z') },
    }));
    expect(times(slots, 'Asia/Karachi')[0]).toBe('09:00');
    expect(times(slots, 'UTC')[0]).toBe('04:00');
    expect(times(slots, 'America/New_York')[0]).toBe('23:00'); // previous evening (EST, UTC-5)
  });

  it('handles the spring-forward DST day (America/New_York, 2026-03-08)', () => {
    const slots = computeSlots(input({
      now: new Date('2026-03-01T00:00:00Z'),
      settings: { timezone: 'America/New_York', slotIntervalMin: 60, windowDays: 60, minNoticeMin: 0 },
      rules: [{ weekday: 7, start: '09:00', end: '12:00' }], // Sunday — the DST day
      range: { start: new Date('2026-03-08T00:00:00Z'), end: new Date('2026-03-09T12:00:00Z') },
    }));
    // 09:00 EDT = 13:00Z (clocks jumped at 02:00), not 14:00Z
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      '2026-03-08T13:00:00.000Z', '2026-03-08T14:00:00.000Z', '2026-03-08T15:00:00.000Z',
    ]);
  });

  it('handles the fall-back DST day (Europe/London, 2026-10-25)', () => {
    const slots = computeSlots(input({
      now: new Date('2026-10-20T00:00:00Z'),
      settings: { timezone: 'Europe/London', slotIntervalMin: 60, windowDays: 60, minNoticeMin: 0 },
      rules: [{ weekday: 7, start: '09:00', end: '11:00' }],
      range: { start: new Date('2026-10-25T00:00:00Z'), end: new Date('2026-10-26T00:00:00Z') },
    }));
    // After the change London is GMT (UTC+0): 09:00 local = 09:00Z
    expect(slots[0].start.toISOString()).toBe('2026-10-25T09:00:00.000Z');
  });
});

describe('isSlotOffered', () => {
  it('accepts an offered slot and rejects others', () => {
    const { range: _r, ...base } = input();
    expect(isSlotOffered(base, new Date('2026-11-03T10:00:00Z'))).toBe(true);
    expect(isSlotOffered(base, new Date('2026-11-03T10:15:00Z'))).toBe(false); // off-grid
    expect(isSlotOffered(base, new Date('2026-11-03T20:00:00Z'))).toBe(false); // after hours
    expect(isSlotOffered({ ...base, busy: [{ start: new Date('2026-11-03T10:00:00Z'), end: new Date('2026-11-03T10:30:00Z') }] }, new Date('2026-11-03T10:00:00Z'))).toBe(false);
  });
});

describe('filterSlots / suggestSlots', () => {
  const week = computeSlots(input({ range: { start: new Date('2026-11-02T00:00:00Z'), end: new Date('2026-11-06T23:59:59Z') } }));

  it('filters by part of day in the visitor zone', () => {
    const afternoon = filterSlots(week, { partOfDay: 'afternoon', zone: 'UTC' });
    expect(times(afternoon)[0]).toBe('12:00');
    expect(times(afternoon).at(-1)).toBe('16:30');
    // In New York (UTC-5) 09:00Z is 04:00 → no "morning" before 12:00Z.
    expect(times(filterSlots(week, { partOfDay: 'morning', zone: 'America/New_York' }), 'America/New_York')[0]).toBe('04:00');
  });

  it('filters by weekday', () => {
    const fridays = filterSlots(week, { weekday: 5, zone: 'UTC' });
    expect(new Set(fridays.map((s) => localDate(s.start, 'UTC')))).toEqual(new Set(['2026-11-06']));
  });

  it('suggests a spread of times over the first days, not the first N of one day', () => {
    const picks = suggestSlots(week, 'UTC', 3, 3);
    expect(picks).toHaveLength(9);
    expect(times(picks).slice(0, 3)).toEqual(['09:00', '13:00', '16:30']);
    expect(new Set(picks.map((s) => localDate(s.start, 'UTC'))).size).toBe(3);
  });
});
