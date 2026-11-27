import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { seedBot } from '../booking/test-utils.js';
import type { HonoEnv } from '../types/index.js';
import botsRouter from './bots.js';
import widgetRouter from './widget.js';

it('keeps fullscreen as the default and publishes only valid saved styles for a bot', async () => {
  const { bot, tenant } = await seedBot();
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => { c.set('tenantId', tenant.id); await next(); });
  app.route('/bots', botsRouter);
  app.route('/widget-config', widgetRouter);
  const update = (voiceUiStyle: string) => app.request(`/bots/${bot.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceUiStyle }),
  });
  const published = async () => {
    const response = await app.request(`/widget-config/${bot.id}`);
    expect(response.status).toBe(200);
    return (await response.json() as { config: { voiceUiStyle: string } }).config.voiceUiStyle;
  };
  expect(await published()).toBe('fullscreen');
  expect((await update('inline')).status).toBe(200);
  expect((await update('other')).status).toBe(400);
  expect(await published()).toBe('inline');
  expect((await update('fullscreen')).status).toBe(200);
  expect(await published()).toBe('fullscreen');
});
