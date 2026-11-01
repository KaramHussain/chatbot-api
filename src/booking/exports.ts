// File exports for owners: CSV, Excel, branded PDF reports, a printable daily agenda, a single-booking
// sheet, and ICS. Everything is generated server-side from the same rows the dashboard shows.
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { DateTime } from 'luxon';
import type { Booking } from './core.js';
import { buildIcs, type IcsEvent } from './notify/ics.js';
import { formatDay, formatTime, safeTimezone, type TimeFormat } from './time.js';

export interface ExportStyle { tz: string; timeFormat: TimeFormat; businessName: string; accent: string }

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed', pending: 'Pending approval', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show', declined: 'Declined',
  held: 'Held', expired: 'Expired',
};
const SOURCE_LABEL: Record<string, string> = { chat: 'Website chat', voice: 'Voice chat', page: 'Booking page', manual: 'Added manually' };

export interface BookingRow {
  date: string; start: string; end: string; name: string; email: string; phone: string; type: string; status: string;
  source: string; tags: string; answers: string; notes: string; booked: string;
}

export function toRows(list: Booking[], s: ExportStyle): BookingRow[] {
  const zone = safeTimezone(s.tz);
  return list.map((b) => ({
    date: DateTime.fromJSDate(b.startsAt, { zone }).toFormat('yyyy-LL-dd'),
    start: formatTime(b.startsAt, zone, s.timeFormat),
    end: formatTime(b.endsAt, zone, s.timeFormat),
    name: b.visitorName ?? '',
    email: b.visitorEmail ?? '',
    phone: b.visitorPhone ?? '',
    type: b.typeName ?? '',
    status: STATUS_LABEL[b.status] ?? b.status,
    source: SOURCE_LABEL[b.source] ?? b.source,
    tags: (b.tags ?? []).join(', '),
    answers: Object.values(b.answers ?? {}).join(' | '),
    notes: b.outcomeNote ?? '',
    booked: DateTime.fromJSDate(b.createdAt, { zone }).toFormat('yyyy-LL-dd HH:mm'),
  }));
}

const COLUMNS: Array<{ key: keyof BookingRow; header: string; width: number }> = [
  { key: 'date', header: 'Date', width: 12 }, { key: 'start', header: 'Start', width: 9 }, { key: 'end', header: 'End', width: 9 },
  { key: 'name', header: 'Name', width: 22 }, { key: 'email', header: 'Email', width: 30 }, { key: 'phone', header: 'Phone', width: 16 },
  { key: 'type', header: 'Meeting type', width: 20 }, { key: 'status', header: 'Status', width: 16 }, { key: 'source', header: 'Source', width: 15 },
  { key: 'tags', header: 'Tags', width: 16 }, { key: 'answers', header: 'Answers', width: 36 }, { key: 'notes', header: 'Notes', width: 28 },
  { key: 'booked', header: 'Booked on', width: 17 },
];

function csvCell(v: unknown): string {
  let s = String(v ?? '');
  // Neutralise spreadsheet formula injection from visitor-supplied text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): Buffer {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(','));
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8'); // BOM so Excel reads UTF-8
}

export function bookingsCsv(list: Booking[], s: ExportStyle): Buffer {
  const rows = toRows(list, s);
  return toCsv(COLUMNS.map((c) => c.header), rows.map((r) => COLUMNS.map((c) => r[c.key])));
}

export async function toXlsx(sheetName: string, headers: Array<{ header: string; width: number }>, rows: unknown[][], accent: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ChatGeniee';
  const ws = wb.addWorksheet(sheetName.slice(0, 30), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map((h) => ({ header: h.header, width: h.width }));
  rows.forEach((r) => ws.addRow(r.map((v) => (typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v))));
  const argb = 'FF' + (accent.replace('#', '').padEnd(6, '0').slice(0, 6) || '4F46E5').toUpperCase();
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function bookingsXlsx(list: Booking[], s: ExportStyle): Promise<Buffer> {
  const rows = toRows(list, s);
  return toXlsx('Appointments', COLUMNS, rows.map((r) => COLUMNS.map((c) => r[c.key])), s.accent);
}

// ─── PDF ────────────────────────────────────────────────────────────────────────

function pdfBuffer(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Producer: 'ChatGeniee' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    // Footer with page numbers on every page.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(8).fillColor('#9ca3af').text(`Page ${i + 1} of ${range.count}   ·   Generated by ChatGeniee`, 40, doc.page.height - 30, { align: 'center', width: doc.page.width - 80, lineBreak: false });
    }
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, s: ExportStyle, title: string, subtitle?: string) {
  doc.rect(0, 0, doc.page.width, 6).fill(s.accent);
  doc.fillColor('#111827').fontSize(20).font('Helvetica-Bold').text(title, 40, 34);
  doc.fontSize(10).font('Helvetica').fillColor('#6b7280').text([s.businessName, subtitle].filter(Boolean).join('  ·  '), 40, doc.y + 2);
  doc.moveDown(1.2);
}

interface PdfColumn { header: string; width: number; get: (r: BookingRow) => string }

export function bookingsPdf(list: Booking[], s: ExportStyle, opts: { title: string; subtitle?: string }): Promise<Buffer> {
  const rows = toRows(list, s);
  const cols: PdfColumn[] = [
    { header: 'Date', width: 62, get: (r) => r.date }, { header: 'Time', width: 70, get: (r) => `${r.start} – ${r.end}` },
    { header: 'Name', width: 96, get: (r) => r.name }, { header: 'Email', width: 120, get: (r) => r.email },
    { header: 'Phone', width: 78, get: (r) => r.phone }, { header: 'Type', width: 74, get: (r) => r.type }, { header: 'Status', width: 55, get: (r) => r.status },
  ];
  return pdfBuffer((doc) => {
    header(doc, s, opts.title, opts.subtitle);
    const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    doc.fontSize(10).fillColor('#374151').font('Helvetica-Bold').text(`${rows.length} appointment${rows.length === 1 ? '' : 's'}`, 40, doc.y, { continued: true })
      .font('Helvetica').fillColor('#6b7280').text(Object.entries(counts).map(([k, v]) => `   ${k}: ${v}`).join(''));
    doc.moveDown(0.8);

    const drawHead = () => {
      const y = doc.y;
      doc.rect(40, y, 555, 20).fill(s.accent);
      let x = 46;
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
      for (const c of cols) { doc.text(c.header, x, y + 6, { width: c.width - 6, lineBreak: false }); x += c.width; }
      doc.y = y + 24;
    };
    drawHead();
    rows.forEach((r, i) => {
      if (doc.y > doc.page.height - 70) { doc.addPage(); drawHead(); }
      const y = doc.y;
      if (i % 2 === 0) doc.rect(40, y - 3, 555, 18).fill('#f9fafb');
      let x = 46;
      doc.fillColor('#111827').font('Helvetica').fontSize(8.5);
      for (const c of cols) { doc.text(c.get(r), x, y, { width: c.width - 8, height: 12, ellipsis: true, lineBreak: false }); x += c.width; }
      doc.y = y + 18;
    });
    if (!rows.length) doc.fillColor('#6b7280').fontSize(11).text('No appointments match these filters.', 40, doc.y + 10);
  });
}

export function agendaPdf(list: Booking[], s: ExportStyle, date: Date): Promise<Buffer> {
  const zone = safeTimezone(s.tz);
  return pdfBuffer((doc) => {
    header(doc, s, 'Daily agenda', DateTime.fromJSDate(date, { zone }).toFormat('cccc, d LLLL yyyy'));
    if (!list.length) { doc.fillColor('#6b7280').fontSize(12).text('Nothing scheduled.', 40, doc.y); return; }
    for (const b of list) {
      if (doc.y > doc.page.height - 110) doc.addPage();
      const y = doc.y;
      doc.rect(40, y, 4, 56).fill(s.accent);
      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(14).text(`${formatTime(b.startsAt, zone, s.timeFormat)} – ${formatTime(b.endsAt, zone, s.timeFormat)}`, 54, y);
      doc.font('Helvetica-Bold').fontSize(11).text(`${b.visitorName ?? 'Guest'}  ·  ${b.typeName ?? 'Appointment'}`, 54, y + 20);
      doc.font('Helvetica').fontSize(9.5).fillColor('#6b7280').text([b.visitorEmail, b.visitorPhone, STATUS_LABEL[b.status] ?? b.status].filter(Boolean).join('   ·   '), 54, y + 36);
      doc.y = y + 68;
    }
  });
}

export function bookingSheetPdf(b: Booking, s: ExportStyle, extras: { questions: Map<string, string>; notes: Array<{ body: string; at: Date; by?: string | null }> }): Promise<Buffer> {
  const zone = safeTimezone(s.tz);
  return pdfBuffer((doc) => {
    header(doc, s, 'Booking sheet', `${b.typeName ?? 'Appointment'}`);
    const field = (label: string, value: string | null | undefined) => {
      if (!value) return;
      doc.font('Helvetica').fontSize(8.5).fillColor('#9ca3af').text(label.toUpperCase(), 40, doc.y);
      doc.font('Helvetica').fontSize(11.5).fillColor('#111827').text(value, 40, doc.y + 1);
      doc.moveDown(0.7);
    };
    field('When', `${formatDay(b.startsAt, zone)}, ${formatTime(b.startsAt, zone, s.timeFormat)} – ${formatTime(b.endsAt, zone, s.timeFormat)}`);
    field('Who', b.visitorName); field('Email', b.visitorEmail); field('Phone', b.visitorPhone);
    field('Status', STATUS_LABEL[b.status] ?? b.status); field('Booked via', SOURCE_LABEL[b.source] ?? b.source);
    if (b.aiSummary?.intent) field('What they were looking for', b.aiSummary.intent);
    const answers = Object.entries(b.answers ?? {});
    if (answers.length) {
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('Answers', 40, doc.y); doc.moveDown(0.4);
      answers.forEach(([id, a]) => field(extras.questions.get(id) ?? id, a));
    }
    if (extras.notes.length) {
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(12).fillColor('#111827').text('Notes', 40, doc.y); doc.moveDown(0.4);
      extras.notes.forEach((n) => field(`${DateTime.fromJSDate(n.at, { zone }).toFormat('d LLL yyyy HH:mm')}${n.by ? ` · ${n.by}` : ''}`, n.body));
    }
  });
}

// ─── ICS ────────────────────────────────────────────────────────────────────────

export function bookingsIcs(list: Booking[], opts: { calendarName: string; organizerEmail: string; businessName: string; dashboardUrl?: (b: Booking) => string }): string {
  const events: IcsEvent[] = list
    .filter((b) => ['confirmed', 'pending', 'completed', 'no_show'].includes(b.status))
    .map((b) => ({
      uid: b.icsUid,
      sequence: b.icsSequence,
      start: b.startsAt,
      end: b.endsAt,
      summary: `${b.typeName ?? 'Appointment'}: ${b.visitorName ?? 'Guest'}${b.status === 'pending' ? ' (pending)' : ''}`,
      description: [b.visitorEmail, b.visitorPhone, opts.dashboardUrl?.(b)].filter(Boolean).join('\n'),
      location: b.locationSnapshot?.value ?? undefined,
      status: b.status === 'pending' ? 'TENTATIVE' : 'CONFIRMED',
      alarmMinutes: 15,
    }));
  return buildIcs(events, { method: null, calendarName: opts.calendarName });
}
