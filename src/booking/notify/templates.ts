// Every booking email. Pure functions: context in → { subject, html, text } out, so they can be
// rendered for previews, tests and the "send me a test" button without touching the database.
import type { AiSummary } from '../schema.js';
import { formatDateTime, formatDay, formatTime, zoneAbbreviation, type TimeFormat } from '../time.js';
import {
  button, esc, factsBlock, heading, paragraph, plain, quote, shell, subheading, textLinks,
  safeColor, type Brand, type Fact,
} from './layout.js';

export interface AgendaItem { start: Date; end: Date; name: string; typeName: string; status: string; url?: string }

export interface EmailCtx {
  brand: Brand;
  /** Zone the times are shown in — the visitor's for visitor emails, the owner's for owner emails. */
  tz: string;
  timeFormat: TimeFormat;
  booking: {
    typeName: string;
    start: Date;
    end: Date;
    durationMin: number;
    visitorName: string;
    visitorEmail: string;
    visitorPhone?: string | null;
    source: string;
    cancelReason?: string | null;
    answers: Array<{ question: string; answer: string }>;
    aiSummary?: AiSummary | null;
  };
  location: { kind: 'link' | 'phone' | 'in_person' | 'later'; value?: string | null };
  priceText?: string | null;
  customMessage?: string | null;
  links: {
    manage?: string; reschedule?: string; cancel?: string; approve?: string; decline?: string;
    dashboard?: string; conversation?: string; google?: string; outlook?: string; ics?: string; rebook?: string; review?: string;
  };
  extra?: {
    otp?: string; oldStart?: Date; reason?: string | null; message?: string | null;
    agenda?: AgendaItem[]; weekly?: WeeklyStats; dateLabel?: string;
  };
}

export interface WeeklyStats {
  rangeLabel: string; total: number; previous: number; confirmed: number; cancelled: number; noShows: number;
  topType?: string; busiestDay?: string; conversion?: string;
}

export interface Rendered { subject: string; html: string; text: string }

const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';

function whenLong(c: EmailCtx, d = c.booking.start, end = c.booking.end): string {
  return `${formatDateTime(d, c.tz, c.timeFormat)} – ${formatTime(end, c.tz, c.timeFormat)} (${zoneAbbreviation(d, c.tz)})`;
}
function whenShort(c: EmailCtx, d = c.booking.start): string {
  return `${formatDay(d, c.tz)}, ${formatTime(d, c.tz, c.timeFormat)}`;
}

function locationFact(c: EmailCtx, audience: 'visitor' | 'owner'): Fact | null {
  const v = c.location.value?.trim();
  switch (c.location.kind) {
    case 'link': return v ? { label: 'Where', value: /^https?:\/\//i.test(v) ? 'Join online' : v, href: /^https?:\/\//i.test(v) ? v : undefined } : null;
    case 'phone': return { label: 'Where', value: audience === 'visitor' ? `Phone call${v ? ` · ${v}` : ''}` : `Phone call${v ? ` · ${v}` : ''}` };
    case 'in_person': return v ? { label: 'Where', value: v, href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}` } : { label: 'Where', value: 'In person' };
    default: return audience === 'visitor' ? { label: 'Where', value: 'Details will be shared before the meeting' } : null;
  }
}

function visitorFacts(c: EmailCtx, accent: string, when = whenLong(c)): string {
  const facts: Fact[] = [
    { label: 'What', value: c.booking.typeName },
    { label: 'When', value: when },
    { label: 'Duration', value: `${c.booking.durationMin} minutes` },
  ];
  const loc = locationFact(c, 'visitor');
  if (loc) facts.push(loc);
  if (c.priceText) facts.push({ label: 'Price', value: c.priceText });
  facts.push({ label: 'With', value: c.brand.name });
  return factsBlock(facts, accent);
}

function visitorFactsText(c: EmailCtx): string {
  const loc = locationFact(c, 'visitor');
  return [`What: ${c.booking.typeName}`, `When: ${whenLong(c)}`, `Duration: ${c.booking.durationMin} minutes`,
    loc ? `Where: ${loc.href ?? loc.value}${loc.href && loc.value !== loc.href ? ` (${loc.value})` : ''}` : '',
    c.priceText ? `Price: ${c.priceText}` : '', `With: ${c.brand.name}`].filter(Boolean).join('\n');
}

function calendarLinks(c: EmailCtx) {
  return [
    c.links.google && { label: 'Google Calendar', href: c.links.google },
    c.links.outlook && { label: 'Outlook', href: c.links.outlook },
    c.links.ics && { label: 'Apple / other (.ics)', href: c.links.ics },
  ].filter(Boolean) as Array<{ label: string; href: string }>;
}

function manageLinks(c: EmailCtx) {
  return [
    c.links.reschedule && { label: 'Reschedule', href: c.links.reschedule },
    c.links.cancel && { label: 'Cancel', href: c.links.cancel },
  ].filter(Boolean) as Array<{ label: string; href: string }>;
}

const text = (c: EmailCtx, lines: Array<string | undefined | false | 0>) => plain([
  ...lines, c.brand.signOff || undefined, `— ${c.brand.name}${c.brand.replyTo ? `\nReply to this email to reach ${c.brand.name}.` : ''}`,
]);

// ─── Visitor emails ────────────────────────────────────────────────────────────

function visitorConfirmed(c: EmailCtx, kind: 'confirmed' | 'approved' = 'confirmed'): Rendered {
  const accent = safeColor(c.brand.accent);
  const title = kind === 'approved' ? 'Your request was approved' : `You're booked, ${first(c.booking.visitorName)}`;
  const intro = kind === 'approved'
    ? `${esc(c.brand.name)} approved your request. Your ${esc(c.booking.typeName.toLowerCase())} is confirmed.`
    : `Your ${esc(c.booking.typeName.toLowerCase())} with <strong>${esc(c.brand.name)}</strong> is confirmed. A calendar invite is attached to this email.`;
  const cal = calendarLinks(c);
  const body = [
    heading(title), paragraph(intro), visitorFacts(c, accent),
    c.customMessage ? quote(c.customMessage) : '',
    c.links.google ? button('Add to Google Calendar', c.links.google, accent) : '',
    textLinks([...cal.filter((l) => l.href !== c.links.google), ...manageLinks(c)]),
  ].join('');
  return {
    subject: `${kind === 'approved' ? "You're confirmed" : 'Confirmed'}: ${c.booking.typeName} with ${c.brand.name} — ${whenShort(c)}`,
    html: shell({ brand: c.brand, preheader: `${c.booking.typeName} · ${whenShort(c)}`, body }),
    text: text(c, [title, visitorFactsText(c), c.customMessage || undefined,
      cal.length && `Add to calendar:\n${cal.map((l) => `${l.label}: ${l.href}`).join('\n')}`,
      manageLinks(c).length && `Need to change plans?\n${manageLinks(c).map((l) => `${l.label}: ${l.href}`).join('\n')}`]),
  };
}

const requestReceived = (c: EmailCtx): Rendered => {
  const accent = safeColor(c.brand.accent);
  const body = [heading('Request received'),
    paragraph(`Thanks ${esc(first(c.booking.visitorName))}. ${esc(c.brand.name)} will review your request and you'll get an email as soon as it is confirmed.`),
    visitorFacts(c, accent), textLinks(manageLinks(c).filter((l) => l.label === 'Cancel').map((l) => ({ ...l, label: 'Withdraw request' })))].join('');
  return {
    subject: `Request received: ${c.booking.typeName} with ${c.brand.name}`,
    html: shell({ brand: c.brand, preheader: 'We will confirm shortly.', body }),
    text: text(c, ['Request received', `Thanks ${first(c.booking.visitorName)}. ${c.brand.name} will review your request and email you when it is confirmed.`, visitorFactsText(c)]),
  };
};

const declined = (c: EmailCtx): Rendered => {
  const accent = safeColor(c.brand.accent);
  const reason = c.extra?.reason || c.booking.cancelReason;
  const body = [heading("We couldn't confirm that time"),
    paragraph(`Unfortunately ${esc(c.brand.name)} can't take your ${esc(c.booking.typeName.toLowerCase())} request for ${esc(whenShort(c))}.`),
    reason ? quote(reason) : '', c.links.rebook ? button('Choose another time', c.links.rebook, accent) : ''].join('');
  return {
    subject: `Update on your ${c.booking.typeName} request with ${c.brand.name}`,
    html: shell({ brand: c.brand, preheader: 'Please pick another time.', body }),
    text: text(c, ["We couldn't confirm that time", `${c.brand.name} can't take your request for ${whenShort(c)}.`, reason || undefined, c.links.rebook && `Choose another time: ${c.links.rebook}`]),
  };
};

const visitorRescheduled = (c: EmailCtx): Rendered => {
  const accent = safeColor(c.brand.accent);
  const old = c.extra?.oldStart ? `Was: ${formatDateTime(c.extra.oldStart, c.tz, c.timeFormat)}` : '';
  const cal = calendarLinks(c);
  const body = [heading('Your appointment time changed'),
    paragraph(`Your ${esc(c.booking.typeName.toLowerCase())} with <strong>${esc(c.brand.name)}</strong> now takes place at the time below. The attached invite updates your calendar.${old ? `<br><span style="color:#9ca3af">${esc(old)}</span>` : ''}`),
    visitorFacts(c, accent), c.links.google ? button('Add to Google Calendar', c.links.google, accent) : '',
    textLinks([...cal.filter((l) => l.href !== c.links.google), ...manageLinks(c)])].join('');
  return {
    subject: `Updated: ${c.booking.typeName} with ${c.brand.name} — now ${whenShort(c)}`,
    html: shell({ brand: c.brand, preheader: `New time: ${whenShort(c)}`, body }),
    text: text(c, ['Your appointment time changed', old, visitorFactsText(c), manageLinks(c).length && manageLinks(c).map((l) => `${l.label}: ${l.href}`).join('\n')]),
  };
};

const visitorCancelled = (c: EmailCtx): Rendered => {
  const accent = safeColor(c.brand.accent);
  const reason = c.extra?.reason || c.booking.cancelReason;
  const body = [heading('Your appointment was cancelled'),
    paragraph(`Your ${esc(c.booking.typeName.toLowerCase())} with <strong>${esc(c.brand.name)}</strong> on ${esc(whenShort(c))} has been cancelled.`),
    reason ? quote(reason) : '', c.links.rebook ? button('Book a new time', c.links.rebook, accent) : ''].join('');
  return {
    subject: `Cancelled: ${c.booking.typeName} with ${c.brand.name}`,
    html: shell({ brand: c.brand, preheader: whenShort(c), body }),
    text: text(c, ['Your appointment was cancelled', `${c.booking.typeName} with ${c.brand.name} on ${whenShort(c)} has been cancelled.`, reason || undefined, c.links.rebook && `Book a new time: ${c.links.rebook}`]),
  };
};

function reminder(c: EmailCtx, hours: 24 | 1): Rendered {
  const accent = safeColor(c.brand.accent);
  const joinUrl = c.location.kind === 'link' && c.location.value && /^https?:\/\//i.test(c.location.value) ? c.location.value : null;
  const title = hours === 24 ? 'Your appointment is tomorrow' : 'Starting in about an hour';
  const body = [heading(title), paragraph(`Hi ${esc(first(c.booking.visitorName))}, a quick reminder about your ${esc(c.booking.typeName.toLowerCase())} with <strong>${esc(c.brand.name)}</strong>.`),
    visitorFacts(c, accent), hours === 1 && joinUrl ? button('Join the meeting', joinUrl, accent) : '', textLinks(manageLinks(c))].join('');
  return {
    subject: hours === 24 ? `Reminder: ${c.booking.typeName} tomorrow at ${formatTime(c.booking.start, c.tz, c.timeFormat)}` : `Starting soon: ${c.booking.typeName} at ${formatTime(c.booking.start, c.tz, c.timeFormat)}`,
    html: shell({ brand: c.brand, preheader: whenShort(c), body }),
    text: text(c, [title, visitorFactsText(c), manageLinks(c).length && manageLinks(c).map((l) => `${l.label}: ${l.href}`).join('\n')]),
  };
}

const followUp = (c: EmailCtx): Rendered => {
  const accent = safeColor(c.brand.accent);
  const msg = c.customMessage || `Thanks for meeting with ${c.brand.name} — we hope it was helpful.`;
  const body = [heading(`Thanks, ${first(c.booking.visitorName)}`), paragraph(esc(msg)),
    c.links.review ? button('Leave a review', c.links.review, accent) : '', c.links.rebook ? textLinks([{ label: 'Book again', href: c.links.rebook }]) : ''].join('');
  return {
    subject: `Thanks for meeting with ${c.brand.name}`,
    html: shell({ brand: c.brand, preheader: 'We hope it was helpful.', body }),
    text: text(c, [`Thanks, ${first(c.booking.visitorName)}`, msg, c.links.review && `Leave a review: ${c.links.review}`, c.links.rebook && `Book again: ${c.links.rebook}`]),
  };
};

const otp = (c: EmailCtx): Rendered => {
  const code = c.extra?.otp ?? '------';
  const body = [heading('Your verification code'),
    paragraph(`Use this code to manage your booking with <strong>${esc(c.brand.name)}</strong>. It expires in 10 minutes.`),
    `<p class="cg-text" style="margin:8px 0 24px;font:700 38px/1 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.28em;color:#111827">${esc(code)}</p>`,
    paragraph('If you did not ask for this, you can safely ignore this email.')].join('');
  return {
    subject: `${code} is your ${c.brand.name} verification code`,
    html: shell({ brand: c.brand, preheader: `Your code is ${code}`, body }),
    text: text(c, [`Your verification code: ${code}`, 'It expires in 10 minutes. If you did not ask for this, ignore this email.']),
  };
};

// ─── Owner emails ──────────────────────────────────────────────────────────────

function ownerFacts(c: EmailCtx, accent: string): string {
  const b = c.booking;
  const facts: Fact[] = [
    { label: 'Who', value: b.visitorName },
    { label: 'Email', value: b.visitorEmail, href: `mailto:${b.visitorEmail}` },
  ];
  if (b.visitorPhone) facts.push({ label: 'Phone', value: b.visitorPhone, href: `tel:${b.visitorPhone}` });
  facts.push({ label: 'What', value: b.typeName }, { label: 'When', value: whenLong(c) }, { label: 'Duration', value: `${b.durationMin} minutes` });
  const loc = locationFact(c, 'owner');
  if (loc) facts.push(loc);
  facts.push({ label: 'Booked via', value: ({ chat: 'Website chat', voice: 'Voice chat', page: 'Booking page', manual: 'Added by you' } as Record<string, string>)[b.source] ?? b.source });
  return factsBlock(facts, accent);
}

function ownerExtras(c: EmailCtx): string {
  const parts: string[] = [];
  const s = c.booking.aiSummary;
  if (s && (s.intent || s.keyFacts?.length)) {
    parts.push(subheading('What they were looking for'));
    if (s.intent) parts.push(paragraph(esc(s.intent)));
    if (s.keyFacts?.length) parts.push(`<ul style="margin:0 0 16px;padding-left:20px;font:14px/1.7 sans-serif;color:#4b5563">${s.keyFacts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`);
  }
  if (c.booking.answers.length) {
    parts.push(subheading('Their answers'));
    parts.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${c.booking.answers.map((a) =>
      `<tr><td style="padding:6px 0;font:14px/1.5 sans-serif;color:#6b7280">${esc(a.question)}</td></tr><tr><td class="cg-text" style="padding:0 0 10px;font:15px/1.5 sans-serif;color:#111827">${esc(a.answer)}</td></tr>`).join('')}</table>`);
  }
  return parts.join('');
}

function ownerButtons(c: EmailCtx, accent: string): string {
  return [c.links.dashboard ? button('View in ChatGeniee', c.links.dashboard, accent) : '',
    textLinks([c.links.conversation && { label: 'View the conversation', href: c.links.conversation }].filter(Boolean) as Array<{ label: string; href: string }>)].join('');
}

function ownerText(c: EmailCtx, head: string): string {
  const b = c.booking;
  const loc = locationFact(c, 'owner');
  return text(c, [head, `Who: ${b.visitorName}\nEmail: ${b.visitorEmail}${b.visitorPhone ? `\nPhone: ${b.visitorPhone}` : ''}\nWhat: ${b.typeName}\nWhen: ${whenLong(c)}${loc ? `\nWhere: ${loc.value}` : ''}`,
    c.booking.aiSummary?.intent && `What they were looking for: ${c.booking.aiSummary.intent}`,
    b.answers.length && b.answers.map((a) => `${a.question}: ${a.answer}`).join('\n'),
    c.links.dashboard && `View in ChatGeniee: ${c.links.dashboard}`, c.links.conversation && `View the conversation: ${c.links.conversation}`]);
}

const ownerBrand = (c: EmailCtx): Brand => ({ ...c.brand, signOff: null, footer: null, replyTo: null });

function ownerNewBooking(c: EmailCtx): Rendered {
  const accent = safeColor(c.brand.accent);
  const body = [heading(`New booking: ${c.booking.visitorName}`), paragraph(`${esc(c.booking.visitorName)} booked a ${esc(c.booking.typeName.toLowerCase())} for <strong>${esc(whenShort(c))}</strong>. It's on your calendar — the invite is attached.`),
    ownerFacts(c, accent), ownerExtras(c), ownerButtons(c, accent)].join('');
  return { subject: `New booking: ${c.booking.visitorName} — ${whenShort(c)}`,
    html: shell({ brand: ownerBrand(c), preheader: `${c.booking.typeName} · ${whenShort(c)}`, body, note: 'You get this because new-booking alerts are on for this bot.' }),
    text: ownerText(c, `New booking: ${c.booking.visitorName}`) };
}

function ownerApproval(c: EmailCtx): Rendered {
  const accent = safeColor(c.brand.accent);
  const body = [heading('Approval needed'), paragraph(`${esc(c.booking.visitorName)} requested a ${esc(c.booking.typeName.toLowerCase())} for <strong>${esc(whenShort(c))}</strong>. The time is held for them until you decide.`),
    ownerFacts(c, accent), ownerExtras(c),
    c.links.approve ? button('Approve', c.links.approve, accent) : '',
    textLinks([c.links.decline && { label: 'Decline', href: c.links.decline }, c.links.dashboard && { label: 'Open in ChatGeniee', href: c.links.dashboard }, c.links.conversation && { label: 'View the conversation', href: c.links.conversation }].filter(Boolean) as Array<{ label: string; href: string }>)].join('');
  return { subject: `Approval needed: ${c.booking.visitorName} — ${whenShort(c)}`,
    html: shell({ brand: ownerBrand(c), preheader: 'One tap to approve or decline.', body }),
    text: ownerText(c, 'Approval needed') + [c.links.approve && `Approve: ${c.links.approve}`, c.links.decline && `Decline: ${c.links.decline}`].filter(Boolean).join('\n') + '\n' };
}

function ownerChange(c: EmailCtx, kind: 'rescheduled' | 'cancelled'): Rendered {
  const accent = safeColor(c.brand.accent);
  const reason = c.extra?.reason || c.booking.cancelReason;
  const head = kind === 'rescheduled' ? `Rescheduled: ${c.booking.visitorName}` : `Cancelled: ${c.booking.visitorName}`;
  const intro = kind === 'rescheduled'
    ? `${esc(c.booking.visitorName)} moved their ${esc(c.booking.typeName.toLowerCase())}${c.extra?.oldStart ? ` from <s>${esc(whenShort(c, c.extra.oldStart))}</s>` : ''} to <strong>${esc(whenShort(c))}</strong>.`
    : `${esc(c.booking.visitorName)} cancelled their ${esc(c.booking.typeName.toLowerCase())} on <strong>${esc(whenShort(c))}</strong>. The time is open again.`;
  const body = [heading(head), paragraph(intro), reason ? quote(reason) : '', ownerFacts(c, accent), ownerButtons(c, accent)].join('');
  return { subject: `${head} — ${whenShort(c)}`, html: shell({ brand: ownerBrand(c), preheader: intro.replace(/<[^>]+>/g, ''), body }), text: ownerText(c, head) };
}

function dailyAgenda(c: EmailCtx): Rendered {
  const accent = safeColor(c.brand.accent);
  const items = c.extra?.agenda ?? [];
  const label = c.extra?.dateLabel ?? 'Today';
  const rows = items.map((a, i) => `<tr><td style="padding:12px 16px 12px 0;font:700 15px/1.3 sans-serif;color:${i === 0 ? accent : '#111827'};white-space:nowrap;vertical-align:top">${esc(formatTime(a.start, c.tz, c.timeFormat))}</td>
    <td class="cg-text" style="padding:12px 0;font:15px/1.4 sans-serif;color:#111827;border-bottom:1px solid #eef0f3">${a.url ? `<a href="${esc(a.url)}" style="color:inherit;text-decoration:none"><strong>${esc(a.name)}</strong></a>` : `<strong>${esc(a.name)}</strong>`}<br><span style="color:#6b7280;font-size:13px">${esc(a.typeName)} · until ${esc(formatTime(a.end, c.tz, c.timeFormat))}</span></td></tr>`).join('');
  const body = [heading(items.length ? `${label}: ${items.length} appointment${items.length > 1 ? 's' : ''}` : `${label}: nothing scheduled`),
    items.length ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 20px">${rows}</table>` : paragraph('Your calendar is clear. Enjoy the quiet.'),
    c.links.dashboard ? button('Open calendar', c.links.dashboard, accent) : ''].join('');
  return { subject: items.length ? `${label}: ${items.length} appointment${items.length > 1 ? 's' : ''}` : `${label}: nothing scheduled`,
    html: shell({ brand: ownerBrand(c), preheader: items[0] ? `First up: ${items[0].name} at ${formatTime(items[0].start, c.tz, c.timeFormat)}` : 'Clear day.', body, note: 'Daily agenda — turn it off in Bookings → Emails.' }),
    text: text(c, [`${label}`, items.map((a) => `${formatTime(a.start, c.tz, c.timeFormat)}  ${a.name} (${a.typeName})`).join('\n') || 'Nothing scheduled.', c.links.dashboard && `Open calendar: ${c.links.dashboard}`]) };
}

function weeklySummary(c: EmailCtx): Rendered {
  const accent = safeColor(c.brand.accent);
  const w = c.extra?.weekly;
  if (!w) return { subject: 'Your week', html: shell({ brand: ownerBrand(c), preheader: '', body: paragraph('No data.') }), text: 'No data.\n' };
  const delta = w.total - w.previous;
  const stat = (n: string | number, l: string) => `<td align="center" style="padding:10px 6px"><div class="cg-text" style="font:700 28px/1 sans-serif;color:#111827">${esc(n)}</div><div class="cg-muted" style="margin-top:6px;font:12px/1.3 sans-serif;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em">${esc(l)}</div></td>`;
  const body = [heading('Your week in bookings'), paragraph(`${esc(w.rangeLabel)} · ${delta === 0 ? 'same as the week before' : `${delta > 0 ? '+' : ''}${delta} vs the week before`}`),
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="cg-panel" style="margin:18px 0;background:#f9fafb;border-radius:10px"><tr>${stat(w.total, 'Bookings')}${stat(w.confirmed, 'Confirmed')}${stat(w.cancelled, 'Cancelled')}${stat(w.noShows, 'No-shows')}</tr></table>`,
    w.topType ? paragraph(`Most booked: <strong>${esc(w.topType)}</strong>.`) : '', w.busiestDay ? paragraph(`Busiest day: <strong>${esc(w.busiestDay)}</strong>.`) : '',
    w.conversion ? paragraph(`Chat → booking conversion: <strong>${esc(w.conversion)}</strong>.`) : '', c.links.dashboard ? button('Open your dashboard', c.links.dashboard, accent) : ''].join('');
  return { subject: `Your week: ${w.total} booking${w.total === 1 ? '' : 's'}`, html: shell({ brand: ownerBrand(c), preheader: `${w.total} bookings, ${w.cancelled} cancelled`, body, note: 'Weekly summary — turn it off in Bookings → Emails.' }),
    text: text(c, ['Your week in bookings', `${w.rangeLabel}`, `Bookings: ${w.total} · Confirmed: ${w.confirmed} · Cancelled: ${w.cancelled} · No-shows: ${w.noShows}`, w.topType && `Most booked: ${w.topType}`, c.links.dashboard && `Open your dashboard: ${c.links.dashboard}`]) };
}

// ─── Registry ──────────────────────────────────────────────────────────────────

export const TEMPLATES = {
  'visitor.confirmed': (c: EmailCtx) => visitorConfirmed(c, 'confirmed'),
  'visitor.approved': (c: EmailCtx) => visitorConfirmed(c, 'approved'),
  'visitor.request_received': requestReceived,
  'visitor.declined': declined,
  'visitor.rescheduled': visitorRescheduled,
  'visitor.cancelled': visitorCancelled,
  'visitor.reminder_24h': (c: EmailCtx) => reminder(c, 24),
  'visitor.reminder_1h': (c: EmailCtx) => reminder(c, 1),
  'visitor.follow_up': followUp,
  'visitor.otp': otp,
  'owner.new_booking': ownerNewBooking,
  'owner.approval_needed': ownerApproval,
  'owner.rescheduled': (c: EmailCtx) => ownerChange(c, 'rescheduled'),
  'owner.cancelled': (c: EmailCtx) => ownerChange(c, 'cancelled'),
  'owner.daily_agenda': dailyAgenda,
  'owner.weekly_summary': weeklySummary,
} satisfies Record<string, (c: EmailCtx) => Rendered>;

export type TemplateName = keyof typeof TEMPLATES;

export const TEMPLATE_AUDIENCE: Record<TemplateName, 'visitor' | 'owner'> = {
  'visitor.confirmed': 'visitor', 'visitor.approved': 'visitor', 'visitor.request_received': 'visitor', 'visitor.declined': 'visitor',
  'visitor.rescheduled': 'visitor', 'visitor.cancelled': 'visitor', 'visitor.reminder_24h': 'visitor', 'visitor.reminder_1h': 'visitor',
  'visitor.follow_up': 'visitor', 'visitor.otp': 'visitor',
  'owner.new_booking': 'owner', 'owner.approval_needed': 'owner', 'owner.rescheduled': 'owner', 'owner.cancelled': 'owner',
  'owner.daily_agenda': 'owner', 'owner.weekly_summary': 'owner',
};

export function isTemplateName(name: string): name is TemplateName {
  return name in TEMPLATES;
}

export function renderEmail(name: TemplateName, ctx: EmailCtx): Rendered {
  return TEMPLATES[name](ctx);
}
