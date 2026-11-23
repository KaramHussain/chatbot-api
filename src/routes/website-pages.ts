import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { botChunks, botDocuments, db, type WebsitePage } from '../db/index.js';
import { queueIngestionJob } from '../lib/sqs.js';
import type { HonoEnv } from '../types/index.js';
import { canonicalWebsiteUrl, websiteUrlSchema } from '../lib/website-url.js';

const router = new Hono<HonoEnv>();
const pageBody = z.object({ url: z.string().url().max(2048) });
const busy = (status: string) => status === 'processing' || status === 'pending';

export async function websitePages(doc: typeof botDocuments.$inferSelect): Promise<WebsitePage[]> {
  if (doc.websiteData.pages) return doc.websiteData.pages.map(page => ({ ...page, hasContent: page.hasContent ?? page.status === 'ready' }));
  const rows = await db.execute(sql`
    SELECT metadata->>'page_url' AS url,
      COALESCE(NULLIF(MAX(metadata->>'page_title'), ''), metadata->>'page_url') AS title,
      MAX(created_at) AS updated
    FROM bot_chunks WHERE document_id = ${doc.id} AND tenant_id = ${doc.tenantId}
      AND metadata->>'page_url' IS NOT NULL AND COALESCE(metadata->>'is_index', 'false') <> 'true'
    GROUP BY metadata->>'page_url' ORDER BY metadata->>'page_url'
  `);
  return rows.map(row => ({ url: String(row.url), title: String(row.title), status: 'ready', hasContent: true, updatedAt: new Date(row.updated as string).toISOString() }));
}

router.get('/:id/pages', async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Website not found' }, 404);
  const [doc] = await db.select().from(botDocuments).where(and(eq(botDocuments.id, c.req.param('id')), eq(botDocuments.tenantId, c.get('tenantId')), eq(botDocuments.type, 'url'))).limit(1);
  if (!doc) return c.json({ error: 'Website not found' }, 404);
  const all = await websitePages(doc);
  const search = (c.req.query('search') ?? '').slice(0, 200).toLowerCase();
  const status = c.req.query('status') ?? 'all';
  const filtered = all.filter(page => (status === 'all' || page.status === status) && `${page.title} ${page.url}`.toLowerCase().includes(search));
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(c.req.query('pageSize')) || 25)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(totalPages, Math.max(1, Math.floor(Number(c.req.query('page')) || 1)));
  return c.json({ pages: filtered.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: filtered.length, totalPages,
    summary: { total: all.length, ready: all.filter(p => p.status === 'ready').length, failed: all.filter(p => p.status === 'failed').length, processing: all.filter(p => busy(p.status)).length }, scrapedAt: doc.websiteData.scrapedAt ?? null });
});

const websiteEditSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: websiteUrlSchema,
  rescrape: z.boolean().default(false),
});

async function schedule(id: string, tenantId: string, pageUrl?: string, edit?: z.infer<typeof websiteEditSchema>) {
  const result = await db.transaction(async tx => {
    const [doc] = await tx.select().from(botDocuments).where(and(eq(botDocuments.id, id), eq(botDocuments.tenantId, tenantId), eq(botDocuments.type, 'url'))).for('update');
    if (!doc?.sourceUrl) return { error: 'Website not found', code: 404 } as const;
    if (busy(doc.status)) return { error: 'A website update is already running. Please wait for it to finish.', code: 409 } as const;
    const urlChanged = !!edit && canonicalWebsiteUrl(doc.sourceUrl) !== edit.url;
    // A corrected address must never continue serving the wrong website's content.
    // Reset its page inventory, exclusions and run identity in the same transaction.
    const baseData = urlChanged ? { maxPages: doc.websiteData.maxPages ?? 30, pages: [], needsScrape: true, jobId: randomUUID() } : doc.websiteData;
    if (urlChanged) await tx.delete(botChunks).where(and(eq(botChunks.documentId, id), eq(botChunks.tenantId, tenantId)));
    const updatedDoc = { ...doc, name: edit?.name ?? doc.name, sourceUrl: edit?.url ?? doc.sourceUrl, websiteData: baseData };
    if (edit && !edit.rescrape) {
      const status = urlChanged ? 'ready' as const : doc.status;
      await tx.update(botDocuments).set({ name: updatedDoc.name, sourceUrl: updatedDoc.sourceUrl, websiteData: baseData,
        status, errorMessage: urlChanged ? null : doc.errorMessage, chunkCount: urlChanged ? 0 : doc.chunkCount, updatedAt: new Date(),
      }).where(eq(botDocuments.id, id));
      return { saved: true, documentId: id, status, rescrapeStarted: false } as const;
    }
    const pages = await websitePages(updatedDoc);
    if (pageUrl && !pages.some(page => page.url === pageUrl)) return { error: 'Webpage not found', code: 404 } as const;
    const jobId = randomUUID();
    const maxPages = Math.min(1000, Math.max(baseData.maxPages ?? 30, pages.length));
    const websiteData = { ...baseData, jobId, maxPages, activePageUrl: pageUrl ?? null, needsScrape: false, pages: pages.map(page => !pageUrl || page.url === pageUrl ? { ...page, status: 'processing' as const, error: null, updatedAt: new Date().toISOString() } : page) };
    await tx.update(botDocuments).set({ name: updatedDoc.name, sourceUrl: updatedDoc.sourceUrl, websiteData, status: 'processing', errorMessage: null, ...(urlChanged ? { chunkCount: 0 } : {}), updatedAt: new Date() }).where(eq(botDocuments.id, id));
    return { doc: updatedDoc, websiteData, jobId, maxPages };
  });
  if ('error' in result) return result;
  if ('saved' in result) return result;
  const { doc, websiteData, jobId, maxPages } = result;
  try {
    await queueIngestionJob({ documentId: id, botId: doc.botId, tenantId, documentType: 'url', documentName: doc.name, sourceUrl: doc.sourceUrl!, maxPages, jobId, ...(pageUrl ? { pageUrl } : {}) });
  } catch {
    await db.transaction(async tx => {
      const [current] = await tx.select().from(botDocuments).where(and(eq(botDocuments.id, id), eq(botDocuments.tenantId, tenantId))).for('update');
      if (!current || current.websiteData.jobId !== jobId) return;
      const failedPages = websiteData.pages.map(page => !pageUrl || page.url === pageUrl ? { ...page, status: 'failed' as const, error: 'The scraping job could not be queued. Please try again.', updatedAt: new Date().toISOString() } : page);
      await tx.update(botDocuments).set({ websiteData: { ...current.websiteData, pages: failedPages }, status: failedPages.some(page => page.hasContent) ? 'ready' : 'failed', errorMessage: 'We could not start the update. Please try again.', updatedAt: new Date() }).where(eq(botDocuments.id, id));
    });
    if (edit) return { saved: true, documentId: id, status: 'failed', rescrapeStarted: false, message: 'Your changes were saved, but the re-scrape could not start. Choose Scrape Again to retry.' } as const;
    return { error: 'We could not start the update. Please try again.', code: 503 } as const;
  }
  return { documentId: id, status: 'processing', rescrapeStarted: true };
}

router.patch('/:id', zValidator('json', websiteEditSchema), async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Website not found' }, 404);
  const result = await schedule(c.req.param('id'), c.get('tenantId'), undefined, c.req.valid('json'));
  return 'error' in result ? c.json({ error: result.error }, result.code) : c.json(result);
});

router.post('/:id/rescrape', async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Website not found' }, 404);
  const result = await schedule(c.req.param('id'), c.get('tenantId'));
  return 'error' in result ? c.json({ error: result.error }, result.code) : c.json(result, 202);
});

router.post('/:id/pages/rescrape', zValidator('json', pageBody), async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Website not found' }, 404);
  const result = await schedule(c.req.param('id'), c.get('tenantId'), c.req.valid('json').url);
  return 'error' in result ? c.json({ error: result.error }, result.code) : c.json(result, 202);
});

router.delete('/:id/pages', zValidator('json', pageBody), async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Website not found' }, 404);
  const url = c.req.valid('json').url;
  const result = await db.transaction(async tx => {
    const [doc] = await tx.select().from(botDocuments).where(and(eq(botDocuments.id, c.req.param('id')), eq(botDocuments.tenantId, c.get('tenantId')), eq(botDocuments.type, 'url'))).for('update');
    if (!doc) return { error: 'Website not found', code: 404 } as const;
    if (busy(doc.status)) return { error: 'Wait for the current update to finish before deleting a page.', code: 409 } as const;
    const pages = await websitePages(doc);
    if (!pages.some(page => page.url === url)) return { error: 'Webpage not found', code: 404 } as const;
    const remaining = pages.filter(page => page.url !== url);
    await tx.delete(botChunks).where(and(eq(botChunks.documentId, doc.id), eq(botChunks.tenantId, doc.tenantId), sql`(${botChunks.metadata}->>'page_url' = ${url} OR ${botChunks.metadata}->>'is_index' = 'true')`));
    await tx.update(botDocuments).set({ websiteData: { ...doc.websiteData, pages: remaining, excludedUrls: [...new Set([...(doc.websiteData.excludedUrls ?? []), url])] },
      chunkCount: sql`(SELECT COUNT(*)::integer FROM bot_chunks WHERE document_id = ${doc.id})`,
      status: remaining.some(page => page.hasContent) || remaining.length === 0 ? 'ready' : 'failed', updatedAt: new Date(), errorMessage: null,
    }).where(eq(botDocuments.id, doc.id));
    return { success: true };
  });
  return 'error' in result ? c.json({ error: result.error }, result.code) : c.json(result);
});

export default router;
