import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { botDocuments, db } from '../db/index.js';
import type { HonoEnv } from '../types/index.js';
import documentsRouter from './documents.js';

const { queue } = vi.hoisted(() => ({ queue: vi.fn(async (_job: unknown) => undefined) }));
vi.mock('../lib/sqs.js', () => ({ queueIngestionJob: queue }));
vi.mock('../lib/s3.js', () => ({ getPresignedUploadUrl: vi.fn(), deleteObject: vi.fn(), buildDocumentKey: vi.fn() }));
if (!process.env.DATABASE_URL?.includes('localhost:55432')) throw new Error('Use the local test database only.');
const tenantId = randomUUID();
const botId = randomUUID();
const page = { url: 'https://example.com/about', title: 'About us', status: 'ready' as const, updatedAt: '2026-11-01T12:00:00.000Z' };
function appFor(tenant: string = tenantId) {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => { c.set('tenantId', tenant); await next(); });
  app.route('/documents', documentsRouter);
  return app;
}
async function website(data: Partial<typeof botDocuments.$inferInsert> = {}) {
  const [doc] = await db.insert(botDocuments).values({ botId, tenantId, name: 'Business', type: 'url', sourceUrl: 'https://example.com', status: 'ready', websiteData: { maxPages: 100, pages: [page], scrapedAt: page.updatedAt }, ...data }).returning();
  return doc;
}
beforeEach(async () => {
  queue.mockReset(); queue.mockResolvedValue(undefined);
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Website test', ${tenantId}) ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO bots (id, tenant_id, name, slug) VALUES (${botId}, ${tenantId}, 'Test bot', 'test') ON CONFLICT DO NOTHING`);
});
afterAll(async () => {
  await db.delete(botDocuments).where(eq(botDocuments.tenantId, tenantId));
  await db.execute(sql`DELETE FROM bots WHERE id = ${botId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
});

describe('website knowledge', () => {
  it('website refresh discovers beyond an old one-page crawl limit', async () => {
    const doc = await website({ websiteData: { maxPages: 1, pages: [page], activePageUrl: page.url } });
    const response = await appFor().request(`/documents/${doc.id}/rescrape`, { method: 'POST' });
    expect(response.status).toBe(202);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 30 }));
    expect(queue.mock.calls[0][0]).not.toHaveProperty('pageUrl');
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.websiteData.activePageUrl).toBeNull();
  });
  const patch = (app: ReturnType<typeof appFor>, id: string, data: unknown) => app.request(`/documents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  it('renames a website without scraping or changing its saved knowledge by default', async () => {
    const data = { maxPages: 50, jobId: randomUUID(), pages: [page], excludedUrls: ['https://example.com/excluded'], scrapedAt: page.updatedAt };
    const doc = await website({ websiteData: data });
    const response = await patch(appFor(), doc.id, { name: 'Updated name', url: 'https://EXAMPLE.com/#section' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ documentId: doc.id, rescrapeStarted: false });
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.name).toBe('Updated name'); expect(saved.websiteData).toEqual(data);
    expect(queue).not.toHaveBeenCalled();
  });
  it('lets a name-only edit explicitly request a re-scrape', async () => {
    const doc = await website();
    const response = await patch(appFor(), doc.id, { name: 'Renamed', url: doc.sourceUrl, rescrape: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rescrapeStarted: true });
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ documentId: doc.id, documentName: 'Renamed', sourceUrl: 'https://example.com/' }));
  });
  it('clears only the old website knowledge on URL correction and can scrape later', async () => {
    const oldRun = randomUUID();
    const doc = await website({ websiteData: { jobId: oldRun, pages: [page], excludedUrls: [page.url], scrapedAt: page.updatedAt } });
    const other = await website();
    for (const id of [doc.id, other.id]) await db.execute(sql`INSERT INTO bot_chunks(document_id,bot_id,tenant_id,content,chunk_index,metadata,embedding) VALUES(${id},${botId},${tenantId},'saved content',0,'{}',${JSON.stringify(Array(1024).fill(0))}::vector)`);
    const response = await patch(appFor(), doc.id, { name: 'Correct website', url: 'https://correct.example.com', rescrape: false });
    expect(response.status).toBe(200);
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.sourceUrl).toBe('https://correct.example.com/'); expect(saved.status).toBe('ready');
    expect(saved.websiteData).toMatchObject({ pages: [], needsScrape: true });
    expect(saved.websiteData.excludedUrls).toBeUndefined(); expect(saved.websiteData.scrapedAt).toBeUndefined();
    expect(saved.websiteData.jobId).not.toBe(oldRun);
    expect(await db.execute(sql`SELECT id FROM bot_chunks WHERE document_id=${doc.id}`)).toHaveLength(0);
    expect(await db.execute(sql`SELECT id FROM bot_chunks WHERE document_id=${other.id}`)).toHaveLength(1);
    expect(queue).not.toHaveBeenCalled();
    const listing: any = await (await appFor().request(`/documents?botId=${botId}`)).json();
    expect(listing.documents.find((item: { id: string }) => item.id === doc.id)).toMatchObject({ needsScrape: true, pageCount: 0 });
    expect((await appFor().request(`/documents/${doc.id}/rescrape`, { method: 'POST' })).status).toBe(202);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ documentId: doc.id, sourceUrl: saved.sourceUrl }));
  });
  it('queues the corrected URL without old seeds, exclusions or page inventory', async () => {
    const doc = await website({ websiteData: { pages: [page], excludedUrls: [page.url], maxPages: 100 } });
    expect((await patch(appFor(), doc.id, { name: 'Correct site', url: 'https://new.example.com/', rescrape: true })).status).toBe(200);
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.websiteData).toMatchObject({ pages: [], maxPages: 100, needsScrape: false });
    expect(saved.websiteData.excludedUrls).toBeUndefined(); expect(saved.status).toBe('processing');
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ documentId: doc.id, sourceUrl: 'https://new.example.com/' }));
  });
  it('reports a saved edit accurately if queue submission fails', async () => {
    const doc = await website(); queue.mockRejectedValueOnce(new Error('Queue unavailable'));
    const response = await patch(appFor(), doc.id, { name: 'Saved correction', url: 'https://correct.example.com', rescrape: true });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ rescrapeStarted: false, message: expect.stringContaining('changes were saved') });
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.name).toBe('Saved correction'); expect(saved.sourceUrl).toBe('https://correct.example.com/'); expect(saved.status).toBe('failed');
  });
  it('rejects foreign, busy, file and invalid website edits', async () => {
    const doc = await website(); const data = { name: 'Edit', url: 'https://example.com' };
    expect((await patch(appFor(randomUUID()), doc.id, data)).status).toBe(404);
    const file = await website({ type: 'pdf' }); expect((await patch(appFor(), file.id, data)).status).toBe(404);
    await db.update(botDocuments).set({ status: 'processing' }).where(eq(botDocuments.id, doc.id));
    expect((await patch(appFor(), doc.id, data)).status).toBe(409);
    for (const invalid of [{ ...data, name: ' ' }, { ...data, url: 'not-a-url' }, { ...data, url: 'ftp://example.com' }]) expect((await patch(appFor(), doc.id, invalid)).status).toBe(400);
    expect(queue).not.toHaveBeenCalled();
  });
  it('rejects invalid addresses, unsupported schemes and embedded login details', async () => {
    for (const url of ['not-a-url', 'ftp://example.com', 'https://user:password@example.com']) {
      const response = await appFor().request('/documents/scrape-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, url }) });
      expect(response.status).toBe(400);
    }
    expect(queue).not.toHaveBeenCalled();
  });
  it('stores the original crawl settings when adding a website', async () => {
    const response = await appFor().request('/documents/scrape-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, url: 'https://example.com', name: 'Our website', maxPages: 200 }) });
    expect(response.status).toBe(201);
    const { documentId } = await response.json() as { documentId: string };
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, documentId));
    expect(saved.websiteData).toMatchObject({ maxPages: 200, jobId: expect.any(String) });
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ documentId, maxPages: 200, jobId: saved.websiteData.jobId }));
  });
  it('leaves an actionable website entry when an initial queue submission fails', async () => {
    queue.mockRejectedValueOnce(new Error('SQS unavailable'));
    const response = await appFor().request('/documents/scrape-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botId, url: 'https://example.com', name: 'Failed initial scrape' }) });
    expect(response.status).toBe(503);
    const saved = await db.select().from(botDocuments).where(eq(botDocuments.tenantId, tenantId));
    expect(saved.find(doc => doc.name === 'Failed initial scrape')?.status).toBe('failed');
  });
  it('returns a durable page inventory without vector details', async () => {
    const doc = await website();
    const response = await appFor().request(`/documents/${doc.id}/pages`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pages: [page], scrapedAt: page.updatedAt, total: 1 });
  });
  it('recovers old webpages, combining repeated metadata and excluding the synthetic index', async () => {
    const doc = await website({ websiteData: {} });
    for (const metadata of [{ page_url: page.url, page_title: page.title }, { page_url: page.url, page_title: page.title }, { page_url: 'https://example.com', page_title: 'Site Index', is_index: true }]) {
      await db.execute(sql`INSERT INTO bot_chunks (document_id, bot_id, tenant_id, content, chunk_index, metadata, embedding) VALUES (${doc.id}, ${botId}, ${tenantId}, 'test', 0, ${JSON.stringify(metadata)}::jsonb, ${JSON.stringify(Array(1024).fill(0))}::vector)`);
    }
    const body: any = await (await appFor().request(`/documents/${doc.id}/pages`)).json();
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0]).toMatchObject({ title: page.title, url: page.url, status: 'ready' });
  });
  it('refreshes the same website with its original page limit and a fresh queue identity', async () => {
    const doc = await website();
    const response = await appFor().request(`/documents/${doc.id}/rescrape`, { method: 'POST' });
    expect(response.status).toBe(202);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ documentId: doc.id, maxPages: 100, jobId: expect.any(String) }));
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.status).toBe('processing'); expect(saved.websiteData.pages?.[0]).toMatchObject({ url: page.url, status: 'processing', hasContent: true });
  });
  it('admits only one of two simultaneous refresh requests', async () => {
    const doc = await website(); const app = appFor();
    const responses = await Promise.all([app.request(`/documents/${doc.id}/rescrape`, { method: 'POST' }), app.request(`/documents/${doc.id}/rescrape`, { method: 'POST' })]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 409]); expect(queue).toHaveBeenCalledTimes(1);
  });
  it('keeps saved pages and allows retry when sending the queue job fails', async () => {
    const doc = await website(); queue.mockRejectedValueOnce(new Error('SQS unavailable'));
    expect((await appFor().request(`/documents/${doc.id}/rescrape`, { method: 'POST' })).status).toBe(503);
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.status).toBe('ready'); expect(saved.websiteData.pages?.[0]).toMatchObject({ url: page.url, status: 'failed', hasContent: true });
    expect((await appFor().request(`/documents/${doc.id}/rescrape`, { method: 'POST' })).status).toBe(202);
  });
  it('protects both endpoints across tenants and rejects files and malformed ids', async () => {
    const doc = await website(); const file = await website({ type: 'pdf' });
    for (const [tenant, id] of [[randomUUID(), doc.id], [tenantId, file.id], [tenantId, 'bad-id']]) {
      expect((await appFor(tenant).request(`/documents/${id}/pages`)).status).toBe(404);
      expect((await appFor(tenant).request(`/documents/${id}/rescrape`, { method: 'POST' })).status).toBe(404);
    }
    expect(queue).not.toHaveBeenCalled();
  });
  it('re-scrapes exactly one saved page, including a failed page', async () => {
    const failed = { ...page, status: 'failed' as const, error: 'HTTP 404 Not Found', hasContent: false };
    const other = { ...page, url: 'https://example.com/contact' };
    const doc = await website({ websiteData: { pages: [failed, other] } });
    const response = await appFor().request(`/documents/${doc.id}/pages/rescrape`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: page.url }) });
    expect(response.status).toBe(202);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ documentId: doc.id, pageUrl: page.url }));
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.websiteData.pages?.[0]).toMatchObject({ url: page.url, status: 'processing', error: null });
    expect(saved.websiteData.pages?.[1]).toMatchObject(other);
    expect(saved.websiteData.activePageUrl).toBe(page.url);
    const listing: any = await (await appFor().request(`/documents?botId=${botId}`)).json();
    expect(listing.documents.find((item: any) => item.id === doc.id).activePageUrl).toBe(page.url);
    await db.update(botDocuments).set({ status: 'ready' }).where(eq(botDocuments.id, doc.id));
    const completed: any = await (await appFor().request(`/documents?botId=${botId}`)).json();
    expect(completed.documents.find((item: any) => item.id === doc.id).activePageUrl).toBeNull();
  });
  it('deletes one webpage and the synthetic index, preserving siblings and the website', async () => {
    const other = { ...page, url: 'https://example.com/contact' };
    const doc = await website({ websiteData: { pages: [page, other] } });
    for (const metadata of [{ page_url: page.url }, { page_url: other.url }, { is_index: true }]) {
      await db.execute(sql`INSERT INTO bot_chunks(document_id,bot_id,tenant_id,content,chunk_index,metadata,embedding) VALUES(${doc.id},${botId},${tenantId},'data',0,${JSON.stringify(metadata)}::jsonb,${JSON.stringify(Array(1024).fill(0))}::vector)`);
    }
    const response = await appFor().request(`/documents/${doc.id}/pages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: page.url }) });
    expect(response.status).toBe(200);
    const [saved] = await db.select().from(botDocuments).where(eq(botDocuments.id, doc.id));
    expect(saved.websiteData.pages).toHaveLength(1);
    expect(saved.websiteData.pages?.[0].url).toBe(other.url);
    expect(saved.websiteData.excludedUrls).toContain(page.url);
    const chunks = await db.execute(sql`SELECT metadata FROM bot_chunks WHERE document_id=${doc.id}`);
    expect(chunks).toHaveLength(1); expect(chunks[0].metadata).toMatchObject({ page_url: other.url });
  });
  it('paginates, searches and filters failure results without hiding failed pages', async () => {
    const many = Array.from({ length: 63 }, (_, i) => ({ ...page, title: `Page ${i}`, url: `https://example.com/page-${i}`, status: i === 62 ? 'failed' as const : 'ready' as const, error: i === 62 ? 'HTTP 503 Service Unavailable' : null }));
    const doc = await website({ websiteData: { pages: many } });
    const app = appFor();
    const first: any = await (await app.request(`/documents/${doc.id}/pages`)).json();
    expect(first.pages).toHaveLength(25); expect(first.totalPages).toBe(3); expect(first.summary.failed).toBe(1);
    const last: any = await (await app.request(`/documents/${doc.id}/pages?page=3`)).json();
    expect(last.pages).toHaveLength(13);
    const filtered: any = await (await app.request(`/documents/${doc.id}/pages?status=failed&search=62`)).json();
    expect(filtered.pages).toHaveLength(1); expect(filtered.pages[0].error).toBe('HTTP 503 Service Unavailable');
  });
  it('rejects foreign, unknown and busy page mutations', async () => {
    const doc = await website();
    for (const method of ['POST', 'DELETE']) {
      const path = `/documents/${doc.id}/pages${method === 'POST' ? '/rescrape' : ''}`;
      const options = { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: page.url }) };
      expect((await appFor(randomUUID()).request(path, options)).status).toBe(404);
      expect((await appFor().request(path, { ...options, body: JSON.stringify({ url: 'https://outside.test/private' }) })).status).toBe(404);
      await db.update(botDocuments).set({ status: 'processing' }).where(eq(botDocuments.id, doc.id));
      expect((await appFor().request(path, options)).status).toBe(409);
      await db.update(botDocuments).set({ status: 'ready' }).where(eq(botDocuments.id, doc.id));
    }
    expect(queue).not.toHaveBeenCalled();
  });
});
