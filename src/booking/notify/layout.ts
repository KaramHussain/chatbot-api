// Shared email shell + small building blocks. Table-based, inline-styled markup so it renders the same
// in Gmail, Outlook (Word engine), Apple Mail and mobile; with a dark-mode override and a plain-text twin.

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface Brand {
  name: string;
  logoUrl?: string | null;
  accent: string;
  signOff?: string | null;
  footer?: string | null;
  replyTo?: string | null;
}

export interface Fact { label: string; value: string; href?: string }

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Accept only #rgb/#rrggbb so a stored colour can never break out of the style attribute. */
export function safeColor(c: string | null | undefined, fallback = '#4F46E5'): string {
  return c && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback;
}

/** Readable text colour (black/white) on a given background. */
export function onColor(hex: string): string {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#111827' : '#ffffff';
}

export function button(label: string, href: string, accent: string): string {
  const color = onColor(accent);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 4px 0"><tr>
    <td style="border-radius:8px;background:${accent}">
      <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font:600 15px/1 ${FONT};color:${color};text-decoration:none;border-radius:8px">${esc(label)}</a>
    </td></tr></table>`;
}

export function textLinks(links: Array<{ label: string; href: string }>): string {
  if (!links.length) return '';
  return `<p style="margin:18px 0 0;font:14px/1.9 ${FONT};color:#6b7280">${links
    .map((l) => `<a href="${esc(l.href)}" style="color:#4b5563;text-decoration:underline">${esc(l.label)}</a>`)
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;')}</p>`;
}

export function factsBlock(facts: Fact[], accent: string): string {
  const rows = facts
    .filter((f) => f.value)
    .map((f) => `<tr>
      <td class="cg-muted" style="padding:9px 16px 9px 0;font:12px/1.4 ${FONT};letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;vertical-align:top;white-space:nowrap">${esc(f.label)}</td>
      <td class="cg-text" style="padding:9px 0;font:15px/1.5 ${FONT};color:#111827;vertical-align:top">${
        f.href ? `<a href="${esc(f.href)}" style="color:${accent};text-decoration:underline">${esc(f.value)}</a>` : esc(f.value)
      }</td></tr>`)
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cg-panel" style="margin:22px 0;background:#f9fafb;border-radius:10px;border-left:4px solid ${accent}">
    <tr><td style="padding:10px 20px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table></td></tr></table>`;
}

export function paragraph(html: string): string {
  return `<p class="cg-text" style="margin:0 0 16px;font:15px/1.65 ${FONT};color:#374151">${html}</p>`;
}

export function heading(text: string): string {
  return `<h1 class="cg-text" style="margin:0 0 14px;font:700 24px/1.25 ${FONT};color:#111827">${esc(text)}</h1>`;
}

export function subheading(text: string): string {
  return `<h2 class="cg-text" style="margin:26px 0 8px;font:600 15px/1.3 ${FONT};color:#111827">${esc(text)}</h2>`;
}

export function quote(text: string): string {
  return `<div class="cg-panel" style="margin:0 0 16px;padding:12px 16px;background:#f9fafb;border-radius:8px;font:14px/1.6 ${FONT};color:#4b5563;white-space:pre-line">${esc(text)}</div>`;
}

export interface Shell {
  brand: Brand;
  preheader: string;
  body: string;
  /** Small print above the footer, e.g. why the recipient got this email. */
  note?: string;
}

export function shell({ brand, preheader, body, note }: Shell): string {
  const accent = safeColor(brand.accent);
  const header = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" height="36" style="display:block;height:36px;max-width:200px;border:0">`
    : `<span class="cg-text" style="font:700 18px/1 ${FONT};color:#111827">${esc(brand.name)}</span>`;
  const footerLines = [
    brand.footer ? esc(brand.footer) : '',
    brand.replyTo ? `Reply to this email to reach ${esc(brand.name)}.` : '',
    `Sent by ${esc(brand.name)} via <a href="https://app.cloudgeniee.com" style="color:#9ca3af">ChatGeniee</a>`,
  ].filter(Boolean);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(brand.name)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .cg-bg { background:#0f1115 !important } .cg-card { background:#171a21 !important }
    .cg-text { color:#f3f4f6 !important } .cg-muted { color:#9ca3af !important } .cg-panel { background:#1f232c !important }
  }
  @media (max-width:620px) { .cg-pad { padding:24px 20px !important } }
</style></head>
<body class="cg-bg" style="margin:0;padding:0;background:#f3f4f6">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cg-bg" style="background:#f3f4f6"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
    <tr><td style="padding:0 4px 16px">${header}</td></tr>
    <tr><td class="cg-card" style="background:#ffffff;border-radius:14px;border-top:4px solid ${accent}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="cg-pad" style="padding:34px 36px">${body}
        ${brand.signOff ? `<p class="cg-muted" style="margin:26px 0 0;font:14px/1.6 ${FONT};color:#6b7280;white-space:pre-line">${esc(brand.signOff)}</p>` : ''}
      </td></tr></table>
    </td></tr>
    ${note ? `<tr><td class="cg-muted" style="padding:16px 8px 0;font:12px/1.6 ${FONT};color:#9ca3af;text-align:center">${esc(note)}</td></tr>` : ''}
    <tr><td class="cg-muted" style="padding:18px 8px 0;font:12px/1.7 ${FONT};color:#9ca3af;text-align:center">${footerLines.join('<br>')}</td></tr>
  </table>
</td></tr></table></body></html>`;
}

/** Plain-text twin: facts and links, no markup. */
export function plain(parts: Array<string | undefined | false | 0>): string {
  return parts.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
