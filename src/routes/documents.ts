import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, botDocuments, botChunks, bots, tenants } from '../db/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { getPresignedUploadUrl, deleteObject, buildDocumentKey } from '../lib/s3.js';
import { queueIngestionJob } from '../lib/sqs.js';
import { v4 as uuidv4 } from 'uuid';
import type { HonoEnv } from '../types/index.js';
import websitePagesRouter from './website-pages.js';

const router = new Hono<HonoEnv>();

// GET /api/documents?botId=... — list documents for a bot
router.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const botId = c.req.query('botId');

  if (!botId) return c.json({ error: 'botId query param required' }, 400);

  // Verify bot belongs to tenant
  const [bot] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.tenantId, tenantId)))
    .limit(1);

  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  const docs = await db
    .select()
    .from(botDocuments)
    .where(and(eq(botDocuments.botId, botId), eq(botDocuments.tenantId, tenantId)))
    .orderBy(desc(botDocuments.createdAt));

  return c.json({ documents: docs.map(({ websiteData, chunkCount: _internalChunkCount, ...doc }) => ({
    ...doc,
    scrapedAt: websiteData.scrapedAt ?? null,
    pageCount: websiteData.pages?.length ?? null,
    failedPageCount: websiteData.pages?.filter(page => page.status === 'failed').length ?? 0,
  })) });
});

router.route('/', websitePagesRouter);

const GLOBAL_DEFAULT_MAX_MB = parseInt(process.env.MAX_UPLOAD_MB ?? '100', 10);

// POST /api/documents/upload-url — Step 1: get presigned S3 URL
const uploadUrlSchema = z.object({
  botId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  contentType: z.enum([
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  fileSizeBytes: z.number().int().positive().max(500 * 1024 * 1024), // hard cap 500 MB
});

router.post('/upload-url', zValidator('json', uploadUrlSchema), async (c) => {
  const tenantId = c.get('tenantId');
  const body = c.req.valid('json');

  // Fetch tenant to get per-tenant upload limit
  const [tenant] = await db
    .select({ maxUploadMb: tenants.maxUploadMb })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const effectiveMaxMb = tenant?.maxUploadMb ?? GLOBAL_DEFAULT_MAX_MB;
  const effectiveMaxBytes = effectiveMaxMb * 1024 * 1024;

  if (body.fileSizeBytes > effectiveMaxBytes) {
    return c.json({ error: `File too large. Maximum allowed for your account is ${effectiveMaxMb} MB.` }, 413);
  }

  // Verify bot belongs to tenant
  const [bot] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, body.botId), eq(bots.tenantId, tenantId)))
    .limit(1);

  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  // Pre-create the document row so we have an ID for the S3 key
  const documentId = uuidv4();
  const s3Key = buildDocumentKey({
    tenantId,
    botId: body.botId,
    documentId,
    filename: body.filename,
  });

  const typeMap: Record<string, 'pdf' | 'txt' | 'docx'> = {
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  };

  await db.insert(botDocuments).values({
    id: documentId,
    botId: body.botId,
    tenantId,
    name: body.filename,
    type: typeMap[body.contentType],
    s3Key,
    fileSizeBytes: body.fileSizeBytes,
    status: 'pending',
  });

  const uploadUrl = await getPresignedUploadUrl({
    key: s3Key,
    contentType: body.contentType,
  });

  return c.json({ documentId, uploadUrl, s3Key });
});

// POST /api/documents/:id/confirm — Step 2: confirm upload done, kick off ingestion
router.post('/:id/confirm', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const [doc] = await db
    .select()
    .from(botDocuments)
    .where(and(eq(botDocuments.id, id), eq(botDocuments.tenantId, tenantId)))
    .limit(1);

  if (!doc) return c.json({ error: 'Not found' }, 404);
  if (!doc.s3Key) return c.json({ error: 'No s3Key' }, 400);

  // Update status to processing
  await db
    .update(botDocuments)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(botDocuments.id, id));

  // Queue the ingestion job
  await queueIngestionJob({
    documentId: doc.id,
    botId: doc.botId,
    tenantId: doc.tenantId,
    s3Key: doc.s3Key,
    documentType: doc.type,
    documentName: doc.name,
  });

  return c.json({ success: true, status: 'processing' });
});

// POST /api/documents/scrape-url — add a website URL as a knowledge source
const scrapeUrlSchema = z.object({
  botId: z.string().uuid(),
  url: z.string().url().max(2048).refine((value) => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  }, 'Use a public http or https website address without login details'),
  name: z.string().trim().min(1).max(200).optional(), // display name, defaults to the URL
  maxPages: z.number().int().min(1).max(1000).default(30),
});

router.post('/scrape-url', zValidator('json', scrapeUrlSchema), async (c) => {
  const tenantId = c.get('tenantId');
  const body = c.req.valid('json');

  // Verify bot belongs to tenant
  const [bot] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.id, body.botId), eq(bots.tenantId, tenantId)))
    .limit(1);

  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  const documentId = uuidv4();
  const displayName = body.name ?? new URL(body.url).hostname;
  const jobId = uuidv4();

  await db.insert(botDocuments).values({
    id: documentId,
    botId: body.botId,
    tenantId,
    name: displayName,
    type: 'url',
    sourceUrl: body.url,
    websiteData: { maxPages: body.maxPages, jobId },
    status: 'processing',
  });

  try {
    await queueIngestionJob({
      documentId, botId: body.botId, tenantId, documentType: 'url',
      documentName: displayName, sourceUrl: body.url, maxPages: body.maxPages, jobId,
    });
  } catch {
    await db.update(botDocuments).set({ status: 'failed', errorMessage: 'We could not start scraping. Please try again.', updatedAt: new Date() }).where(eq(botDocuments.id, documentId));
    return c.json({ error: 'We could not start scraping. Find the website below and choose Scrape Again.' }, 503);
  }

  return c.json({ documentId, status: 'processing' }, 201);
});

// DELETE /api/documents/:id — delete document + all its chunks
router.delete('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const { id } = c.req.param();

  const [doc] = await db
    .select()
    .from(botDocuments)
    .where(and(eq(botDocuments.id, id), eq(botDocuments.tenantId, tenantId)))
    .limit(1);

  if (!doc) return c.json({ error: 'Not found' }, 404);

  // Delete vectors first
  await db.delete(botChunks).where(eq(botChunks.documentId, id));

  // Delete from S3
  if (doc.s3Key) {
    try {
      await deleteObject(doc.s3Key);
    } catch {
      // Non-fatal: S3 object may already be deleted
    }
  }

  // Delete DB record (cascades to chunks if any remain)
  await db.delete(botDocuments).where(eq(botDocuments.id, id));

  return c.json({ success: true });
});

export default router;
