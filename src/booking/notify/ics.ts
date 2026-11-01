// RFC 5545 calendar files. Times are written in UTC (`Z`), so no VTIMEZONE block is needed and every
// calendar app renders them in the viewer's own zone. UID stays constant for a booking and SEQUENCE
// increases on every change, which is how Gmail/Outlook/Apple update or cancel the existing event.

export interface IcsEvent {
  uid: string;
  sequence: number;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  organizer?: { name: string; email: string };
  attendee?: { name: string; email: string };
  status?: 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE';
  /** Minutes before start for a display alarm (0 = none). */
  alarmMinutes?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function icsUtc(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold to 75 octets per line with CRLF + space continuation (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const chSize = Buffer.byteLength(ch, 'utf8');
    if (size + chSize > (out.length === 0 ? 75 : 74)) { out.push(current); current = ch; size = chSize; }
    else { current += ch; size += chSize; }
  }
  out.push(current);
  return out.join('\r\n ');
}

export type IcsMethod = 'REQUEST' | 'CANCEL' | 'PUBLISH';

function eventLines(e: IcsEvent, method: IcsMethod | null): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${icsUtc(new Date())}`,
    `DTSTART:${icsUtc(e.start)}`,
    `DTEND:${icsUtc(e.end)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    `STATUS:${method === 'CANCEL' ? 'CANCELLED' : e.status ?? 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
  ];
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  if (e.organizer) lines.push(`ORGANIZER;CN=${escapeText(e.organizer.name)}:mailto:${e.organizer.email}`);
  if (e.attendee && method !== 'PUBLISH') {
    lines.push(`ATTENDEE;CN=${escapeText(e.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${e.attendee.email}`);
  }
  if (e.alarmMinutes && method !== 'CANCEL') {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.summary)}`, `TRIGGER:-PT${e.alarmMinutes}M`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

export function buildIcs(events: IcsEvent[], opts: { method?: IcsMethod | null; calendarName?: string } = {}): string {
  const method = opts.method === undefined ? 'PUBLISH' : opts.method;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CloudGeniee//ChatGeniee Bookings//EN', 'CALSCALE:GREGORIAN'];
  if (method) lines.push(`METHOD:${method}`);
  if (opts.calendarName) lines.push(`X-WR-CALNAME:${escapeText(opts.calendarName)}`, `NAME:${escapeText(opts.calendarName)}`);
  for (const e of events) lines.push(...eventLines(e, method));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
