// End-to-end booking conversation against a locally running API (Docker test DB + real Bedrock).
//   API_URL=http://localhost:3099 MODEL=mistral.mistral-large-3-675b-instruct npx tsx scripts/booking-e2e.ts
import { eq } from 'drizzle-orm';
import { db, tenants } from '../src/db/index.js';
import { bookings } from '../src/booking/schema.js';
import { seedBot } from '../src/booking/test-utils.js';

const API = process.env.API_URL ?? 'http://localhost:3099';
const MODEL = process.env.MODEL;

const { bot, tenant, type } = await seedBot({ plan: 'growth', tz: 'Asia/Karachi' });
if (MODEL) await db.update(tenants).set({ aiModel: MODEL }).where(eq(tenants.id, tenant.id));

let conversationId: string | undefined;
let lastSlots: { start: string; dayLabel: string; timeLabel: string }[] = [];

async function turn(message: string, pickSlot?: { start: string; typeName?: string }, action?: 'confirm') {
  const t0 = Date.now();
  const res = await fetch(`${API}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: bot.id, message, conversationId, timezone: 'Asia/Karachi', pickSlot, action }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
  let text = ''; const ui: Array<Record<string, unknown>> = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const d = JSON.parse(line.slice(6));
    if (d.type === 'meta') conversationId = d.conversationId;
    else if (d.type === 'chunk') text += d.text;
    else if (d.type === 'booking_ui') { ui.push(d); if (d.kind === 'slots') lastSlots = d.slots; }
    else if (d.type === 'error') throw new Error('stream error');
  }
  console.log(`\n> ${message}${pickSlot ? '  [tapped]' : ''}   (${Date.now() - t0} ms)`);
  console.log(`  bot: ${text.trim().replace(/\s+/g, ' ')}`);
  for (const u of ui) console.log(`  [ui:${u.kind}] ${u.kind === 'slots' ? (u.slots as unknown[]).length + ' times' : JSON.stringify(u).slice(0, 140)}`);
  return { text, ui };
}

console.log(`bot ${bot.id}  type ${type.id}  model ${MODEL ?? 'tenant default'}`);
await turn('Hi, I would like to book a consultation please');
const first = lastSlots[1] ?? lastSlots[0];
if (!first) throw new Error('no slots were offered');
await turn(`${first.dayLabel}, ${first.timeLabel}`, { start: first.start, typeName: type.name });
await turn('My name is Sara Khan');
await turn('sara@example.com');
await turn('Yes, confirm it.', undefined, 'confirm');

const rows = await db.select().from(bookings).where(eq(bookings.botId, bot.id));
console.log('\nbookings in DB:', rows.map((b) => `${b.status} ${b.startsAt.toISOString()} ${b.visitorName} <${b.visitorEmail}> source=${b.source}`));
console.log('conversation:', conversationId);
process.exit(0);
