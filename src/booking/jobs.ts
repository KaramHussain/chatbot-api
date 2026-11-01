// A tiny Postgres-backed job queue (FOR UPDATE SKIP LOCKED). Emails, reminders, follow-ups and AI
// summaries are all jobs, so a booking never waits on (or fails because of) email delivery, and a
// worker crash loses nothing — unfinished jobs are simply picked up again.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bookingJobs } from './schema.js';
import type { DbOrTx } from './core.js';

export type JobKind = 'email' | 'summary';

export interface EmailJobPayload {
  template: string;
  /** Only for templates that need an explicit recipient (e.g. a one-off owner test). */
  to?: string;
}

export async function enqueueJob(
  client: DbOrTx,
  job: { kind: JobKind; bookingId?: string; botId?: string; runAt?: Date; payload?: Record<string, unknown> },
): Promise<void> {
  await client.insert(bookingJobs).values({
    kind: job.kind,
    bookingId: job.bookingId,
    botId: job.botId,
    runAt: job.runAt ?? new Date(),
    payload: job.payload ?? {},
  });
}

export function enqueueEmail(
  client: DbOrTx,
  args: { template: string; bookingId: string; botId: string; runAt?: Date; to?: string },
): Promise<void> {
  const payload: EmailJobPayload = { template: args.template, ...(args.to ? { to: args.to } : {}) };
  return enqueueJob(client, { kind: 'email', bookingId: args.bookingId, botId: args.botId, runAt: args.runAt, payload: { ...payload } });
}

/** Cancel not-yet-run scheduled emails of a booking (e.g. reminders after it was cancelled/moved). */
export async function cancelScheduledEmails(client: DbOrTx, bookingId: string, templates: string[]): Promise<void> {
  if (!templates.length) return;
  await client
    .update(bookingJobs)
    .set({ doneAt: new Date(), lastError: 'superseded' })
    .where(and(
      eq(bookingJobs.bookingId, bookingId),
      isNull(bookingJobs.doneAt),
      eq(bookingJobs.kind, 'email'),
      inArray(sql`${bookingJobs.payload}->>'template'`, templates),
    ));
}

export type ClaimedJob = typeof bookingJobs.$inferSelect;

const LOCK_TIMEOUT = '2 minutes';

/** Atomically claim up to `limit` due jobs for this worker. */
export async function claimJobs(limit = 10): Promise<ClaimedJob[]> {
  const rows = await db.execute(sql`
    UPDATE booking_jobs SET locked_at = now(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM booking_jobs
      WHERE done_at IS NULL AND run_at <= now()
        AND (locked_at IS NULL OR locked_at < now() - interval '${sql.raw(LOCK_TIMEOUT)}')
      ORDER BY run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, booking_id AS "bookingId", bot_id AS "botId", run_at AS "runAt",
              payload, attempts, last_error AS "lastError"
  `);
  return rows as unknown as ClaimedJob[];
}

export async function completeJob(id: string): Promise<void> {
  await db.update(bookingJobs).set({ doneAt: new Date(), lockedAt: null }).where(eq(bookingJobs.id, id));
}

const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 30, 120];

/** Failed job: retry later with backoff, give up after MAX_ATTEMPTS. */
export async function failJob(job: ClaimedJob, error: string): Promise<void> {
  const exhausted = job.attempts >= MAX_ATTEMPTS;
  const delay = BACKOFF_MIN[Math.min(job.attempts - 1, BACKOFF_MIN.length - 1)] ?? 120;
  await db
    .update(bookingJobs)
    .set({
      lastError: error.slice(0, 500),
      lockedAt: null,
      doneAt: exhausted ? new Date() : null,
      runAt: exhausted ? job.runAt : new Date(Date.now() + delay * 60_000),
    })
    .where(eq(bookingJobs.id, job.id));
}
