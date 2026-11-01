// Background worker for Bookings: runs queued jobs (emails, reminders, summaries), frees expired holds
// and sends owner digests. Run as its own process:  node dist/booking/worker.js
import 'dotenv/config';
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

let stopping = false;
const timers: NodeJS.Timeout[] = [];

async function loop() {
  while (!stopping) {
    try {
      const jobs = await claimJobs(10);
      if (jobs.length) { await Promise.all(jobs.map(run)); continue; }
    } catch (err) {
      console.error('worker poll failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

timers.push(setInterval(() => expireStaleHolds().catch((e) => console.error('hold sweep failed', e)), HOUSEKEEPING_MS));
timers.push(setInterval(() => runDigestScheduler().catch((e) => console.error('digest scheduler failed', e)), DIGEST_MS));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; timers.forEach(clearInterval); setTimeout(() => process.exit(0), 1_500); });
}

console.log(JSON.stringify({ evt: 'booking_worker_started' }));
void loop();
