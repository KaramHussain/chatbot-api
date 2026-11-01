// Styles and the small client library shared by the hosted booking pages. These are plain strings that are
// inlined into each page — no build step, no dependencies. NOTE: no backticks or template placeholders in
// the JS below; it is written with plain string concatenation on purpose.

export const CSS = String.raw`
:root{--bg:#f4f5f7;--card:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--soft:#f9fafb;--accent:#4F46E5;--on-accent:#fff;--danger:#b3261e;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#f3f4f6;--muted:#9ca3af;--line:#272b35;--soft:#1f232c;--danger:#f2877f;--ok:#4ade80}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.embed body{background:transparent}
.wrap{max-width:580px;margin:0 auto;padding:28px 16px 56px}
.embed .wrap{padding:8px}
.brand{display:flex;align-items:center;gap:12px;margin:0 4px 18px}
.brand img{height:34px;max-width:180px;object-fit:contain}
.brand b{font-size:17px;font-weight:700;letter-spacing:-.01em}
.card{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--accent);border-radius:16px;padding:26px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
h1{font-size:22px;line-height:1.25;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:15px;margin:22px 0 10px}
p{margin:0 0 14px}.muted{color:var(--muted)}.small{font-size:13px}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between}
.stack{display:flex;flex-direction:column;gap:10px}
.btn{appearance:none;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit;font-weight:600;padding:12px 18px;border-radius:10px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;transition:filter .15s}
.btn:hover{filter:brightness(.97)}.btn:focus-visible,.opt:focus-visible,.day:focus-visible,.time:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.danger{color:var(--danger);border-color:var(--danger)}
.btn[disabled]{opacity:.55;cursor:not-allowed}
.btn.block{width:100%}
.opt{width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;cursor:pointer;font:inherit;color:inherit;transition:border-color .15s,background .15s}
.opt:hover{border-color:var(--accent);background:var(--soft)}
.opt b{display:block}.opt span{color:var(--muted);font-size:13px}
.days{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 10px;scrollbar-width:thin}
.day{flex:0 0 auto;min-width:74px;border:1px solid var(--line);background:var(--card);color:inherit;border-radius:12px;padding:9px 10px;text-align:center;cursor:pointer;font:inherit}
.day small{display:block;color:var(--muted);font-size:12px}.day b{font-size:15px}
.day[aria-pressed=true]{border-color:var(--accent);background:var(--accent);color:var(--on-accent)}.day[aria-pressed=true] small{color:inherit;opacity:.85}
.times{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
.time{border:1px solid var(--line);background:var(--card);color:inherit;border-radius:10px;padding:11px 8px;font:inherit;font-weight:600;cursor:pointer;min-height:44px}
.time:hover{border-color:var(--accent);color:var(--accent)}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
input,select,textarea{width:100%;font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px;min-height:44px}
textarea{min-height:88px;resize:vertical}
.field{margin-bottom:14px}.err{color:var(--danger);font-size:13px;margin-top:6px}
.panel{background:var(--soft);border-radius:12px;padding:6px 16px;margin:16px 0}
.panel .r{display:flex;gap:16px;padding:9px 0}.panel .r+.r{border-top:1px solid var(--line)}
.panel .k{width:84px;flex:0 0 auto;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding-top:2px}
.links{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:14px;font-size:14px}.links a{color:var(--muted)}
.notice{border-radius:10px;padding:11px 14px;margin:0 0 16px;font-size:14px;border:1px solid var(--line);background:var(--soft)}
.notice.bad{border-color:var(--danger);color:var(--danger)}.notice.good{border-color:var(--ok);color:var(--ok)}
.check{width:44px;height:44px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:14px}
.spin{width:22px;height:22px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s .8s linear infinite;margin:30px auto}
@keyframes s{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
.foot{text-align:center;font-size:12px;color:var(--muted);margin-top:18px}.foot a{color:inherit}
`;

export const COMMON_JS = String.raw`
var BOOT = JSON.parse(document.getElementById('boot').textContent);
var app = document.getElementById('app');
if (new URLSearchParams(location.search).get('embed')) document.documentElement.className = 'embed';

function h(tag, attrs) {
  var el = document.createElement(tag);
  for (var k in (attrs || {})) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
    else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function api(path, opts) {
  opts = opts || {};
  return fetch(path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Something went wrong'); e.code = j.code; throw e; } return j; }); });
}

function setAccent(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex || '')) return;
  var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--on-accent', (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#111827' : '#ffffff');
}

function brandBar(business) {
  setAccent(business.accent);
  return h('div', { class: 'brand' }, business.logoUrl ? h('img', { src: business.logoUrl, alt: business.name }) : null, business.logoUrl ? null : h('b', { text: business.name }));
}

function mount(node) { app.replaceChildren(node); window.scrollTo({ top: 0 }); }
function loading() { mount(h('div', { class: 'wrap' }, h('div', { class: 'spin', role: 'status', 'aria-label': 'Loading' }))); }
function footer() { return h('div', { class: 'foot' }, 'Powered by ', h('a', { href: 'https://app.cloudgeniee.com', target: '_blank', rel: 'noopener', text: 'ChatGeniee' })); }
function page(business, card) { return h('div', { class: 'wrap' }, business ? brandBar(business) : null, card, footer()); }
function fail(message) { mount(page(null, h('div', { class: 'card' }, h('h1', { text: 'Something is not right' }), h('p', { class: 'muted', text: message })))); }

function myTimezone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }
function tzSelect(current, onChange) {
  var zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { zones = []; }
  if (zones.indexOf(current) < 0) zones.unshift(current);
  var sel = h('select', { 'aria-label': 'Time zone', onchange: function () { onChange(sel.value); } });
  zones.forEach(function (z) { var o = h('option', { value: z, text: z.replace(/_/g, ' ') }); if (z === current) o.selected = true; sel.appendChild(o); });
  return sel;
}

function row(k, v) { return v ? h('div', { class: 'r' }, h('div', { class: 'k', text: k }), h('div', { text: v })) : null; }

function summaryPanel(b) {
  var rows = [row('What', b.typeName), row('When', b.dayLabel + ', ' + b.timeLabel + ' (' + b.tzLabel + ')'), row('Duration', b.durationMin + ' minutes'), row('Where', b.where), row('Name', b.name)];
  return h('div', { class: 'panel' }, rows);
}

function calendarLinks(b) {
  return h('div', { class: 'links' },
    h('a', { href: b.googleUrl, target: '_blank', rel: 'noopener', text: 'Google Calendar' }),
    h('a', { href: b.outlookUrl, target: '_blank', rel: 'noopener', text: 'Outlook' }),
    h('a', { href: b.icsUrl, text: 'Apple / other (.ics)' }));
}

/* Day strip + time grid used by the booking page and by reschedule. cfg: {fetchDays(from), tz, onTz, onPick} */
function timePicker(cfg) {
  var box = h('div');
  var state = { days: [], selected: null, next: null, busy: false };
  var strip = h('div', { class: 'days', role: 'group', 'aria-label': 'Choose a day' });
  var grid = h('div', { class: 'times', role: 'group', 'aria-label': 'Choose a time' });
  var more = h('button', { class: 'btn', type: 'button', text: 'Show more days', onclick: function () { load(state.next); } });
  var note = h('p', { class: 'muted small' });

  function drawDays() {
    strip.replaceChildren();
    state.days.forEach(function (d) {
      var parts = d.dayLabel.split(' ');
      strip.appendChild(h('button', { class: 'day', type: 'button', 'aria-pressed': state.selected === d.date ? 'true' : 'false',
        onclick: function () { state.selected = d.date; drawDays(); drawTimes(); } },
        h('small', { text: parts[0] }), h('b', { text: parts[1] + ' ' + parts[2] })));
    });
  }
  function drawTimes() {
    grid.replaceChildren();
    var d = state.days.filter(function (x) { return x.date === state.selected; })[0];
    if (!d) return;
    d.slots.forEach(function (s) { grid.appendChild(h('button', { class: 'time', type: 'button', text: s.timeLabel, onclick: function () { cfg.onPick(s, d); } })); });
  }
  function load(from, reset) {
    if (state.busy) return;
    state.busy = true; more.disabled = true;
    cfg.fetchDays(from, cfg.tz()).then(function (res) {
      state.busy = false; more.disabled = false;
      if (reset) { state.days = []; state.selected = null; }
      state.days = state.days.concat(res.days); state.next = res.nextFrom;
      if (!state.selected && state.days[0]) state.selected = state.days[0].date;
      note.textContent = state.days.length ? 'Times shown in ' + (res.tzLabel ? res.tzLabel + ' · ' : '') + cfg.tz().replace(/_/g, ' ') : 'No open times in the next two weeks.';
      more.style.display = state.next && (res.days.length || !state.days.length) ? '' : 'none';
      drawDays(); drawTimes();
    }).catch(function (e) { state.busy = false; more.disabled = false; note.textContent = e.message; });
  }
  box.appendChild(h('div', { class: 'field' }, h('label', { text: 'Your time zone' }), tzSelect(cfg.tz(), function (z) { cfg.onTz(z); load(null, true); })));
  box.appendChild(strip); box.appendChild(grid); box.appendChild(note); box.appendChild(more);
  load(null, true);
  return box;
}
`;
