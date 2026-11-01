// Seeds a realistic Bookings demo (Docker test DB only) and prints the bot id + an owner login token.
//   DATABASE_URL=postgresql://cgtest:cgtest@localhost:55432/cgtest API_SECRET=... npx tsx scripts/booking-demo-seed.ts
import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { bots, conversations, db, messages, users } from '../src/db/index.js';
import { signToken } from '../src/middleware/auth.js';
import { seedBot } from '../src/booking/test-utils.js';
import { bookingEvents, bookingNotes, bookingSettings, bookings, emailLog, meetingTypes } from '../src/booking/schema.js';
import { upsertPerson } from '../src/booking/service.js';
import { hashToken } from '../src/booking/tokens.js';

const TZ = 'Asia/Karachi';
const { tenant, bot, type: consult, ownerEmail } = await seedBot({ plan: 'growth', tz: TZ });

await db.update(bots).set({ name: 'Smile Dental Assistant', displayName: 'Smile Dental', primaryColor: '#0e7490', bookingEnabled: true }).where(eq(bots.id, bot.id));
await db.update(bookingSettings).set({
  onboardingDoneAt: new Date(), pageSlug: `smile-dental-${Math.random().toString(36).slice(2, 6)}`, timeFormat: '12h',
  branding: { senderName: 'Smile Dental', accent: '#0e7490', signOff: 'See you soon,\nThe Smile Dental team' } as never,
  notify: { dailyAgenda: true, weeklySummary: true, followUp: true, followUpHours: 3 } as never,
}).where(eq(bookingSettings.botId, bot.id));

await db.update(meetingTypes).set({ name: 'Consultation', description: 'A first conversation about your goals.', priceText: 'Free', locationValue: 'https://meet.google.com/abc-defg-hij' }).where(eq(meetingTypes.id, consult.id));
const [discovery] = await db.insert(meetingTypes).values({
  botId: bot.id, tenantId: tenant.id, name: 'Quick call', slug: 'quick-call', durationMin: 15, locationType: 'phone', locationValue: '+92 300 1234567', sort: 1,
  questions: [{ id: 'topic', label: 'What would you like to discuss?', type: 'long_text', required: true }] as never,
}).returning();
const [review] = await db.insert(meetingTypes).values({
  botId: bot.id, tenantId: tenant.id, name: 'Treatment plan review', slug: 'plan-review', durationMin: 60, locationType: 'in_person', locationValue: '12 Clifton Road, Karachi',
  confirmation: 'approval', priceText: 'PKR 5,000', sort: 2, bufferAfterMin: 10,
  questions: [{ id: 'insurer', label: 'Insurance provider', type: 'text', required: false }] as never,
}).returning();
const types = [consult, discovery, review];

const PEOPLE = [
  ['Sara Khan', 'sara.khan@example.com', '+92 300 1112233'], ['Omar Ali', 'omar.ali@example.com', '+92 321 4445566'], ['Aisha Malik', 'aisha@example.com', null],
  ['Bilal Ahmed', 'bilal.ahmed@example.com', '+92 333 7778899'], ['Hina Raza', 'hina.raza@example.com', '+92 345 1239876'], ['Usman Tariq', 'usman@example.com', null],
  ['Fatima Noor', 'fatima.noor@example.com', '+92 301 5551212'], ['Zain Abbas', 'zain.abbas@example.com', null], ['Maryam Sheikh', 'maryam@example.com', '+92 312 6543210'],
  ['Hamza Iqbal', 'hamza.iqbal@example.com', null], ['Noor Fatima', 'noor.f@example.com', '+92 322 9990000'], ['Ali Hassan', 'ali.hassan@example.com', '+92 302 2223344'],
];
const TOPICS = ['Teeth whitening before my wedding in December', 'Persistent pain in a lower molar', 'Braces for my 14-year-old', 'Second opinion on a root canal', 'Routine check-up and cleaning', 'Pricing for dental implants'];
const SOURCES = ['chat', 'chat', 'chat', 'voice', 'page', 'manual'] as const;

let day = 0; const taken: Array<[number, number]> = []; let made = 0;
const now = DateTime.now().setZone(TZ);
for (let off = -16; off <= 14 && made < 34; off++) {
  const d = now.plus({ days: off });
  if (d.weekday > 5) continue;
  for (const hour of [9, 10, 11, 13, 14, 15, 16]) {
    if (Math.random() > 0.38) continue;
    const type = types[(made + off + 40) % 3];
    const person = PEOPLE[made % PEOPLE.length];
    const start = d.set({ hour, minute: 0, second: 0, millisecond: 0 }).toJSDate();
    if (start.getTime() < Date.now() - 20 * 86400_000) continue;
    const end = new Date(start.getTime() + type.durationMin * 60_000);
    const blockEnd = end.getTime() + type.bufferAfterMin * 60_000;
    if (taken.some(([a, b]) => start.getTime() < b && a < blockEnd)) continue; // never overlap (the DB would refuse it)
    taken.push([start.getTime(), blockEnd]);
    const past = end.getTime() < Date.now();
    const status = past ? (['completed', 'completed', 'completed', 'no_show', 'cancelled'] as const)[made % 5]
      : type.confirmation === 'approval' && made % 2 === 0 ? 'pending' : (['confirmed', 'confirmed', 'confirmed', 'cancelled'] as const)[made % 4];
    const source = SOURCES[made % SOURCES.length];

    let conversationId: string | null = null;
    if (source === 'chat' || source === 'voice') {
      const [c] = await db.insert(conversations).values({ botId: bot.id, tenantId: tenant.id, visitorName: person[0], visitorEmail: person[1], visitorPhone: person[2], messageCount: 6, startedAt: new Date(start.getTime() - 3 * 86400_000), lastMessageAt: new Date(start.getTime() - 3 * 86400_000 + 600_000) }).returning({ id: conversations.id });
      conversationId = c.id;
      const topic = TOPICS[made % TOPICS.length];
      await db.insert(messages).values([
        { conversationId, role: 'user', content: `Hi, ${topic.toLowerCase()}. Can I book something?` },
        { conversationId, role: 'assistant', content: 'Of course! Here are some times that work — tap one, or tell me what suits you.' },
        { conversationId, role: 'user', content: 'The first one is perfect.' },
        { conversationId, role: 'assistant', content: `You're all set, ${person[0].split(' ')[0]}! The invite is on its way to your email.` },
      ] as never);
    }
    const p = await upsertPerson(db, { botId: bot.id, tenantId: tenant.id, name: person[0], email: person[1], phone: person[2], timezone: TZ, source });
    const answers = type.questions.length ? { [type.questions[0].id]: type === discovery ? TOPICS[made % TOPICS.length] : 'Jubilee' } : {};
    const [b] = await db.insert(bookings).values({
      botId: bot.id, tenantId: tenant.id, meetingTypeId: type.id, personId: p.id, conversationId, status, startsAt: start, endsAt: end,
      blockStartsAt: start, blockEndsAt: new Date(end.getTime() + type.bufferAfterMin * 60_000), typeName: type.name,
      visitorName: person[0], visitorEmail: person[1], visitorPhone: person[2], visitorTz: made % 4 === 0 ? 'America/New_York' : TZ, answers, source,
      locationSnapshot: { type: type.locationType, value: type.locationValue }, icsUid: `${crypto.randomUUID()}@cloudgeniee.com`,
      cancelReason: status === 'cancelled' ? 'Something came up' : null, cancelledBy: status === 'cancelled' ? 'visitor' : null,
      createdAt: new Date(start.getTime() - (2 + (made % 6)) * 86400_000), tags: made % 5 === 0 ? ['vip'] : made % 7 === 0 ? ['follow-up'] : [],
      aiSummary: conversationId ? { intent: `Wants help with: ${TOPICS[made % TOPICS.length].toLowerCase()}.`, keyFacts: made % 2 ? ['Prefers afternoons', 'First-time patient'] : ['Referred by a friend'], questions: ['How much will it cost?'], sentiment: 'positive' } : null,
    } as never).returning();
    await db.insert(bookingEvents).values({ bookingId: b.id, botId: bot.id, type: status === 'pending' ? 'requested' : 'created', actor: 'visitor', data: { source }, at: b.createdAt });
    if (status === 'cancelled') await db.insert(bookingEvents).values({ bookingId: b.id, botId: bot.id, type: 'cancelled', actor: 'visitor', data: { reason: 'Something came up' } });
    if (made % 4 === 0) await db.insert(bookingNotes).values({ bookingId: b.id, personId: p.id, botId: bot.id, authorName: 'Owner', body: 'Prefers a text message the day before.' });
    await db.insert(emailLog).values([
      { tenantId: tenant.id, botId: bot.id, bookingId: b.id, template: 'visitor.confirmed', recipient: person[1], audience: 'visitor', subject: `Confirmed: ${type.name}`, status: 'sent', sentAt: b.createdAt },
      { tenantId: tenant.id, botId: bot.id, bookingId: b.id, template: 'owner.new_booking', recipient: ownerEmail, audience: 'owner', subject: `New booking: ${person[0]}`, status: made === 3 ? 'failed' : 'sent', error: made === 3 ? 'Mailbox unavailable' : null, sentAt: b.createdAt },
    ] as never);
    made++; day++;
  }
}
// A few lead-only contacts (left their details, never booked).
for (const [n, e] of [['Kamran Butt', 'kamran@example.com'], ['Sana Mir', 'sana.mir@example.com'], ['Danish Rao', 'danish@example.com']]) {
  await db.insert(conversations).values({ botId: bot.id, tenantId: tenant.id, visitorName: n, visitorEmail: e, messageCount: 4 });
}

const [owner] = await db.select().from(users).where(eq(users.tenantId, tenant.id)).limit(1);
const token = await signToken({ sub: owner.id, email: owner.email, role: 'client_admin', tenantId: tenant.id, name: owner.name });
console.log(JSON.stringify({ botId: bot.id, token, user: { id: owner.id, email: owner.email, name: owner.name, role: 'client_admin', tenantId: tenant.id }, bookings: made, hashed: hashToken('x').length }));
process.exit(0);
