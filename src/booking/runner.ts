// The Bookings background runner: queued jobs (emails, reminders, AI summaries), the expired-hold sweep
// and owner digests. It runs inside the API process by default (memory-friendly on a small server);
// `worker.ts` can run it as its own process instead (set BOOKING_WORKER=external on the API).
import { expireStaleHolds } from './core.js';
import { runDigestScheduler } from './digests.js';
import { claimJobs, completeJob, failJob, type ClaimedJob } from './jobs.js';
import { processEmailJob } from './notify/notifier.js';
import { summariseBooking } from './summary.js';

const POLL_MS = 2_000;
const HOUSEKEEPING_MS = 30_000;
const DIGEST_MS = 60_000;

async function run(job: ClaimedJob): Promise<void> {
  try {
    if (job.kind === 'email') {
      const outcome = await processEmailJob({ id: job.id, bookingId: job.bookingId, payload: job.payload });
      console.log(JSON.stringify({ evt: 'booking_job', kind: job.kind, template: job.payload.template, outcome, id: job.id }));
    } else if (job.kind === 'summary' && job.bookingId) {
      await summariseBooking(job.bookingId);
    }
    await completeJob(job.id);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(JSON.stringify({ evt: 'booking_job_failed', kind: job.kind, id: job.id, attempts: job.attempts, error: message }));
    await failJob(job, message);
  }
}

/** Starts polling. Returns a function that stops it. */
export function startBookingWorker(): () => void {
  let stopping = false;

  const timers = [
    setInterval(() => expireStaleHolds().catch((e) => console.error('hold sweep failed', e)), HOUSEKEEPING_MS),
    setInterval(() => runDigestScheduler().catch((e) => console.error('digest scheduler failed', e)), DIGEST_MS),
  ];

  void (async function loop() {
    while (!stopping) {
      try {
        const jobs = await claimJobs(10);
        if (jobs.length) { await Promise.all(jobs.map(run)); continue; }
      } catch (err) {
        console.error('booking worker poll failed', err);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();

  console.log(JSON.stringify({ evt: 'booking_worker_started' }));
  return () => { stopping = true; timers.forEach(clearInterval); };
}
