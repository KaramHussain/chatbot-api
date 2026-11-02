// Verifies that a bot only offers bookings once it is switched on AND set up (Docker test DB + real Bedrock).
//   API_URL=http://localhost:3099 npx tsx scripts/booking-gate-check.ts
import { eq } from 'drizzle-orm';
import { db, tenants } from '../src/db/index.js';
import { bookingSettings, meetingTypes } from '../src/booking/schema.js';
import { seedBot } from '../src/booking/test-utils.js';

const API = process.env.API_URL ?? 'http://localhost:3099';
const MODEL = process.env.MODEL ?? 'mistral.mistral-large-3-675b-instruct';

async function ask(botId: string, message: string) {
  const res = await fetch(`${API}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, message, timezone: 'Asia/Karachi' }) });
  let text = ''; let cards = 0;
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const d = JSON.parse(line.slice(6));
    if (d.type === 'chunk') text += d.text;
    if (d.type === 'booking_ui') cards++;
  }
  return { text: text.trim().replace(/\s+/g, ' '), cards };
}

const cases: Array<[string, (botId: string, tenantId: string) => Promise<void>]> = [
  ['Bookings OFF', async (b) => { await db.update(bookingSettings).set({ enabled: false }).where(eq(bookingSettings.botId, b)); }],
  ['ON but no meeting type created', async (b) => { await db.delete(meetingTypes).where(eq(meetingTypes.botId, b)); }],
  ['ON, set up (control)', async () => undefined],
];

let failed = 0;
for (const [label, prepare] of cases) {
  const { bot, tenant } = await seedBot({ plan: 'growth', tz: 'Asia/Karachi' });
  await db.update(tenants).set({ aiModel: MODEL }).where(eq(tenants.id, tenant.id));
  await prepare(bot.id, tenant.id);
  const r = await ask(bot.id, 'Hi, I would like to book a meeting');
  // A set-up bot starts the ask-first flow ("which day or time?"); a bot that is off / not set up must not.
  const startsFlow = /preferred? (day|time)|day or time|full week/i.test(r.text);
  const expectFlow = label.includes('control');
  const ok = r.cards === 0 && startsFlow === expectFlow;
  if (!ok) failed++;
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${label}\n  cards: ${r.cards}\n  bot: ${r.text.slice(0, 220)}`);
}
console.log(failed ? `\n${failed} case(s) failed` : '\nAll gating cases passed');
process.exit(failed ? 1 : 0);
