import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bots, conversations, db } from '../db/index.js';
import { bookingSettings, meetingTypes } from '../booking/schema.js';
import { seedBot } from '../booking/test-utils.js';
import botsRouter from './bots.js';
import type { HonoEnv } from '../types/index.js';

function appFor(tenantId: string) {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => { c.set('tenantId', tenantId); await next(); });
  app.route('/bots', botsRouter);
  return app;
}
const duplicate = (app: ReturnType<typeof appFor>, id: string, name: string) =>
  app.request(`/bots/${id}/duplicate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });

describe('duplicate bot', () => {
  it('copies configuration but not knowledge, chats or bookings', async () => {
    const { tenant, bot } = await seedBot({ plan: 'enterprise' });
    await db.update(bots).set({
      systemPrompt: 'Be concise and friendly.', primaryColor: '#0e7490', voiceEnabled: true, voiceId: 'aura-2-delia-en',
      welcomeMessage: 'Hello there!', leadCaptureEnabled: true, themeName: 'Ocean', bookingEnabled: true,
    }).where(eq(bots.id, bot.id));
    await db.insert(conversations).values({ botId: bot.id, tenantId: tenant.id });

    const res = await duplicate(appFor(tenant.id), bot.id, 'Dental Bot (copy)');
    expect(res.status).toBe(201);
    const { bot: copy, startedInactive } = await res.json() as { bot: typeof bot; startedInactive: boolean };

    expect(copy.id).not.toBe(bot.id);
    expect(copy.name).toBe('Dental Bot (copy)');
    expect(copy.slug).toBe('dental-bot-copy');
    expect(copy.status).toBe('active');
    expect(startedInactive).toBe(false);
    // configuration is copied…
    expect(copy).toMatchObject({ systemPrompt: 'Be concise and friendly.', primaryColor: '#0e7490', voiceEnabled: true, voiceId: 'aura-2-delia-en', welcomeMessage: 'Hello there!', leadCaptureEnabled: true, themeName: 'Ocean' });
    // …but nothing that belongs to the original's data
    expect(copy.bookingEnabled).toBe(false);
    expect(await db.select().from(conversations).where(eq(conversations.botId, copy.id))).toHaveLength(0);
    expect(await db.select().from(bookingSettings).where(eq(bookingSettings.botId, copy.id))).toHaveLength(0);
    expect(await db.select().from(meetingTypes).where(eq(meetingTypes.botId, copy.id))).toHaveLength(0);
  });

  it('gives each copy a unique slug', async () => {
    const { tenant, bot } = await seedBot({ plan: 'enterprise' });
    const app = appFor(tenant.id);
    const slugs: string[] = [];
    for (let i = 0; i < 3; i++) slugs.push(((await (await duplicate(app, bot.id, 'Same Name')).json()) as { bot: { slug: string } }).bot.slug);
    expect(slugs).toEqual(['same-name', 'same-name-2', 'same-name-3']);
  });

  it('starts the copy inactive when the plan has no room for another active bot', async () => {
    const { tenant, bot } = await seedBot({ plan: 'starter' }); // Free plan: 1 active bot — the original
    const res = await duplicate(appFor(tenant.id), bot.id, 'Second bot');
    expect(res.status).toBe(201);
    const body = await res.json() as { bot: { status: string }; startedInactive: boolean };
    expect(body.bot.status).toBe('inactive');
    expect(body.startedInactive).toBe(true);
  });

  it("cannot copy another tenant's bot, drafts, or use an empty name", async () => {
    const a = await seedBot({ plan: 'enterprise' });
    const b = await seedBot({ plan: 'enterprise' });
    expect((await duplicate(appFor(b.tenant.id), a.bot.id, 'Stolen')).status).toBe(404);

    await db.update(bots).set({ status: 'draft' }).where(eq(bots.id, a.bot.id));
    expect((await duplicate(appFor(a.tenant.id), a.bot.id, 'From draft')).status).toBe(400);

    await db.update(bots).set({ status: 'active' }).where(eq(bots.id, a.bot.id));
    expect((await duplicate(appFor(a.tenant.id), a.bot.id, '   ')).status).toBe(400);
    expect(await db.select().from(bots).where(and(eq(bots.tenantId, a.tenant.id), eq(bots.name, 'Stolen')))).toHaveLength(0);
  });
});
