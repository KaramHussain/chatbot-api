// "Add to calendar" deep links that work without any account connection.
import { icsUtc } from './ics.js';

export interface CalendarLinkInput {
  title: string;
  start: Date;
  end: Date;
  details?: string;
  location?: string;
}

export function googleCalendarUrl(e: CalendarLinkInput): string {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${icsUtc(e.start)}/${icsUtc(e.end)}`,
  });
  if (e.details) p.set('details', e.details);
  if (e.location) p.set('location', e.location);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function outlookCalendarUrl(e: CalendarLinkInput): string {
  const p = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: e.title,
    startdt: e.start.toISOString(),
    enddt: e.end.toISOString(),
  });
  if (e.details) p.set('body', e.details);
  if (e.location) p.set('location', e.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${p.toString()}`;
}
