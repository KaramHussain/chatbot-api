// Per-page client scripts for the hosted booking pages. Plain JS strings — see assets.ts for the shared
// helpers (h, api, timePicker, …). No backticks or template placeholders in here.

export const BOOK_JS = String.raw`
var ref = BOOT.ref, base = '/api/public/booking/' + encodeURIComponent(ref);
var S = { info: null, type: null, tz: myTimezone(), hold: null };

function start() {
  loading();
  api(base + '/info').then(function (info) {
    S.info = info; setAccent(info.business.accent);
    if (info.paused) return mount(page(info.business, h('div', { class: 'card' }, h('h1', { text: 'Booking is paused' }), h('p', { class: 'muted', text: info.pauseMessage || 'Please check back soon.' }))));
    if (!info.types.length) return fail('Nothing can be booked here yet.');
    if (info.types.length === 1) { S.type = info.types[0]; return showTimes(); }
    showTypes();
  }).catch(function (e) { fail(e.message); });
}

function showTypes() {
  var info = S.info;
  mount(page(info.business, h('div', { class: 'card' },
    h('h1', { text: 'Book a ' + info.term }), h('p', { class: 'muted', text: 'What would you like to book?' }),
    h('div', { class: 'stack' }, info.types.map(function (t) {
      return h('button', { class: 'opt', type: 'button', onclick: function () { S.type = t; showTimes(); } },
        h('b', { text: t.name }), h('span', { text: t.durationMin + ' min' + (t.priceText ? ' · ' + t.priceText : '') + (t.description ? ' · ' + t.description : '') }));
    })))));
}

function showTimes(notice) {
  var t = S.type, info = S.info;
  var picker = timePicker({
    tz: function () { return S.tz; }, onTz: function (z) { S.tz = z; },
    fetchDays: function (from, tz) { return api(base + '/availability?typeId=' + t.id + '&tz=' + encodeURIComponent(tz) + (from ? '&from=' + from : '')); },
    onPick: function (slot) { pickSlot(slot); }
  });
  mount(page(info.business, h('div', { class: 'card' },
    info.types.length > 1 ? h('button', { class: 'btn', type: 'button', style: 'margin-bottom:16px', onclick: showTypes, text: 'Back' }) : null,
    h('h1', { text: t.name }),
    h('p', { class: 'muted', text: t.durationMin + ' minutes' + (t.priceText ? ' · ' + t.priceText : '') + (t.description ? ' · ' + t.description : '') }),
    notice ? h('div', { class: 'notice bad', role: 'alert', text: notice }) : null,
    h('h2', { text: 'Pick a time' }), picker)));
}

function pickSlot(slot) {
  loading();
  api(base + '/hold', { method: 'POST', body: { typeId: S.type.id, start: slot.start, tz: S.tz } }).then(function (res) {
    S.hold = { id: res.holdId, expires: new Date(res.expiresAt).getTime(), slot: slot };
    showDetails();
  }).catch(function (e) { showTimes(e.message); });
}

function field(label, control, required) {
  return h('div', { class: 'field' }, h('label', { text: label + (required ? '' : ' (optional)') }), control);
}

function questionControl(q, values) {
  var c;
  if (q.type === 'long_text') c = h('textarea', { maxlength: 1000 });
  else if (q.type === 'yes_no' || q.type === 'single_choice') {
    c = h('select', null, h('option', { value: '', text: 'Select…' }));
    (q.type === 'yes_no' ? ['Yes', 'No'] : q.options || []).forEach(function (o) { c.appendChild(h('option', { value: o, text: o })); });
  } else if (q.type === 'multi_choice') {
    var wrap = h('div', { class: 'stack' });
    (q.options || []).forEach(function (o) { wrap.appendChild(h('label', { style: 'font-weight:400;display:flex;gap:8px;align-items:center' }, h('input', { type: 'checkbox', value: o, style: 'width:auto;min-height:0', onchange: function () { var a = wrap.querySelectorAll('input:checked'); values[q.id] = Array.prototype.map.call(a, function (x) { return x.value; }).join(', '); } }), o)); });
    return field(q.label, wrap, q.required);
  } else c = h('input', { type: q.type === 'phone' ? 'tel' : q.type === 'number' ? 'number' : q.type === 'date' ? 'date' : 'text', maxlength: 300 });
  c.addEventListener('input', function () { values[q.id] = c.value; });
  c.addEventListener('change', function () { values[q.id] = c.value; });
  return field(q.label, c, q.required);
}

function showDetails() {
  var t = S.type, info = S.info, slot = S.hold.slot, values = {};
  var name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: 120 });
  var email = h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: 200 });
  var phone = h('input', { type: 'tel', autocomplete: 'tel', maxlength: 40 });
  var error = h('div', { class: 'err', role: 'alert' });
  var timer = h('span', { class: 'muted small' });
  var submit = h('button', { class: 'btn primary block', type: 'submit', text: t.needsApproval ? 'Send request' : 'Confirm booking' });

  var tick = setInterval(function () {
    var left = Math.max(0, Math.round((S.hold.expires - Date.now()) / 1000));
    timer.textContent = left > 0 ? 'We are holding this time for ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'This time was released.';
    if (left <= 0) { clearInterval(tick); showTimes('That time was released while you were filling in your details. Please pick again.'); }
  }, 1000);

  var form = h('form', { novalidate: true, onsubmit: function (ev) {
    ev.preventDefault(); error.textContent = '';
    if (!name.value.trim()) return (error.textContent = 'Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())) return (error.textContent = 'Please enter a valid email address.');
    if (info.requirePhone && !phone.value.trim()) return (error.textContent = 'Please enter a phone number.');
    for (var i = 0; i < t.questions.length; i++) if (t.questions[i].required && !String(values[t.questions[i].id] || '').trim()) return (error.textContent = 'Please answer: ' + t.questions[i].label);
    submit.disabled = true; submit.textContent = 'Booking…';
    api(base + '/confirm', { method: 'POST', body: { holdId: S.hold.id, name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim() || null, answers: values } })
      .then(function (res) { clearInterval(tick); showDone(res.booking); })
      .catch(function (e) { submit.disabled = false; submit.textContent = t.needsApproval ? 'Send request' : 'Confirm booking'; if (e.code === 'slot_taken' || e.code === 'slot_unavailable' || e.code === 'hold_expired') { clearInterval(tick); showTimes(e.message); } else error.textContent = e.message; });
  } },
    field('Your name', name, true), field('Email', email, true), field('Phone', phone, info.requirePhone),
    t.questions.map(function (q) { return questionControl(q, values); }), error, submit);

  mount(page(info.business, h('div', { class: 'card' },
    h('button', { class: 'btn', type: 'button', style: 'margin-bottom:16px', onclick: function () { clearInterval(tick); showTimes(); }, text: 'Back' }),
    h('h1', { text: 'Your details' }),
    h('div', { class: 'panel' }, row('What', t.name), row('When', slot.timeLabel + ' · ' + S.tz.replace(/_/g, ' ')), row('Duration', t.durationMin + ' minutes')),
    h('p', null, timer), form)));
}

function showDone(b) {
  var pending = b.status === 'pending';
  mount(page(S.info.business, h('div', { class: 'card' },
    h('div', { class: 'check', 'aria-hidden': 'true', text: pending ? '…' : '✓' }),
    h('h1', { text: pending ? 'Request sent' : "You're booked" }),
    h('p', { class: 'muted', text: pending ? 'The business will review it and email you at ' + b.email + '.' : 'A confirmation and calendar invite are on their way to ' + b.email + '.' }),
    summaryPanel(b), pending ? null : calendarLinks(b),
    h('div', { class: 'links' }, h('a', { href: b.manageUrl, text: 'Reschedule or cancel' })))));
}

start();
`;

export const MANAGE_JS = String.raw`
var base = '/api/public/booking/manage/' + encodeURIComponent(BOOT.token);
var M = { data: null, tz: myTimezone() };

function load() {
  loading();
  api(base + '?tz=' + encodeURIComponent(M.tz)).then(function (d) { M.data = d; show(); }).catch(function (e) { fail(e.message); });
}

function statusNotice(b, d) {
  if (b.status === 'cancelled') return h('div', { class: 'notice bad', text: 'This appointment was cancelled.' });
  if (b.status === 'declined') return h('div', { class: 'notice bad', text: 'This request was declined.' });
  if (b.status === 'pending') return h('div', { class: 'notice', text: 'Waiting for the business to confirm.' });
  if (!d.canChange) return h('div', { class: 'notice', text: 'This appointment has already taken place.' });
  return null;
}

function show(message) {
  var d = M.data, b = d.booking;
  var actions = d.canChange ? h('div', { class: 'row', style: 'gap:10px;margin-top:6px' },
    d.canReschedule ? h('button', { class: 'btn primary', style: 'flex:1', type: 'button', onclick: showReschedule, text: 'Reschedule' }) : null,
    h('button', { class: 'btn danger', style: 'flex:1', type: 'button', onclick: showCancel, text: 'Cancel appointment' })) : null;
  mount(page(d.business, h('div', { class: 'card' },
    message ? h('div', { class: 'notice good', role: 'status', text: message }) : null,
    h('h1', { text: b.typeName || 'Your appointment' }), statusNotice(b, d),
    summaryPanel(b), (b.status === 'confirmed' && d.canChange) ? calendarLinks(b) : null, actions)));
}

function showReschedule() {
  var d = M.data;
  var picker = timePicker({
    tz: function () { return M.tz; }, onTz: function (z) { M.tz = z; },
    fetchDays: function (from, tz) { return api(base + '/availability?tz=' + encodeURIComponent(tz) + (from ? '&from=' + from : '')); },
    onPick: function (slot, day) { confirmMove(slot, day); }
  });
  mount(page(d.business, h('div', { class: 'card' }, h('button', { class: 'btn', type: 'button', style: 'margin-bottom:16px', onclick: function () { show(); }, text: 'Back' }), h('h1', { text: 'Pick a new time' }), picker)));
}

function confirmMove(slot, day) {
  var d = M.data;
  var error = h('div', { class: 'err', role: 'alert' });
  var go = h('button', { class: 'btn primary block', type: 'button', text: 'Confirm new time', onclick: function () {
    go.disabled = true; go.textContent = 'Moving…';
    api(base + '/reschedule', { method: 'POST', body: { start: slot.start } }).then(function () { return api(base + '?tz=' + encodeURIComponent(M.tz)); })
      .then(function (nd) { M.data = nd; show('Your appointment was moved. An updated invite is on its way.'); })
      .catch(function (e) { go.disabled = false; go.textContent = 'Confirm new time'; error.textContent = e.message; });
  } });
  mount(page(d.business, h('div', { class: 'card' }, h('button', { class: 'btn', type: 'button', style: 'margin-bottom:16px', onclick: showReschedule, text: 'Back' }),
    h('h1', { text: 'Move to this time?' }), h('div', { class: 'panel' }, row('New time', day.dayLabel + ', ' + slot.timeLabel), row('Time zone', M.tz.replace(/_/g, ' '))), error, go)));
}

function showCancel() {
  var d = M.data;
  var reason = h('textarea', { maxlength: 300, placeholder: 'Let them know why (optional)' });
  var error = h('div', { class: 'err', role: 'alert' });
  var go = h('button', { class: 'btn danger block', type: 'button', text: 'Yes, cancel it', onclick: function () {
    go.disabled = true; go.textContent = 'Cancelling…';
    api(base + '/cancel', { method: 'POST', body: { reason: reason.value.trim() || null } }).then(function () { return api(base + '?tz=' + encodeURIComponent(M.tz)); })
      .then(function (nd) { M.data = nd; show('Your appointment was cancelled.'); })
      .catch(function (e) { go.disabled = false; go.textContent = 'Yes, cancel it'; error.textContent = e.message; });
  } });
  mount(page(d.business, h('div', { class: 'card' }, h('button', { class: 'btn', type: 'button', style: 'margin-bottom:16px', onclick: function () { show(); }, text: 'Back' }),
    h('h1', { text: 'Cancel this appointment?' }), summaryPanel(d.booking), h('div', { class: 'field' }, h('label', { text: 'Reason' }), reason), error, go)));
}

if (new URLSearchParams(location.search).get('action') === 'cancel') { load(); setTimeout(function () { if (M.data && M.data.canChange) showCancel(); }, 600); }
else if (new URLSearchParams(location.search).get('action') === 'reschedule') { load(); setTimeout(function () { if (M.data && M.data.canReschedule) showReschedule(); }, 600); }
else load();
`;

export const ACTION_JS = String.raw`
var base = '/api/public/booking/action/' + encodeURIComponent(BOOT.token);
loading();
api(base).then(function (d) {
  var b = d.booking, approve = d.action === 'approve';
  if (!d.pending) return mount(page(d.business, h('div', { class: 'card' }, h('h1', { text: 'Already handled' }), h('p', { class: 'muted', text: 'This request is no longer waiting for a decision (it is ' + b.status.replace('_', '-') + ').' }), summaryPanel(b))));
  var reason = h('textarea', { maxlength: 300, placeholder: 'Message to the visitor (optional)' });
  var error = h('div', { class: 'err', role: 'alert' });
  var go = h('button', { class: 'btn block ' + (approve ? 'primary' : 'danger'), type: 'button', text: approve ? 'Approve this booking' : 'Decline this request', onclick: function () {
    go.disabled = true;
    api(base, { method: 'POST', body: { reason: approve ? null : (reason.value.trim() || null) } }).then(function () {
      mount(page(d.business, h('div', { class: 'card' }, h('div', { class: 'check', 'aria-hidden': 'true', text: '✓' }), h('h1', { text: approve ? 'Approved' : 'Declined' }), h('p', { class: 'muted', text: 'We emailed ' + (b.name || 'the visitor') + ' to let them know.' }))));
    }).catch(function (e) { go.disabled = false; error.textContent = e.message; });
  } });
  mount(page(d.business, h('div', { class: 'card' }, h('h1', { text: approve ? 'Approve this booking?' : 'Decline this request?' }),
    h('p', { class: 'muted', text: (b.name || 'A visitor') + ' asked for the time below.' }), summaryPanel(b),
    approve ? null : h('div', { class: 'field' }, h('label', { text: 'Message' }), reason), error, go)));
}).catch(function (e) { fail(e.message); });
`;
