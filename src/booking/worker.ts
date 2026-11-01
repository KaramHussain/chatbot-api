// Standalone process entry for the Bookings runner:  node dist/booking/worker.js
// Only needed when the API runs with BOOKING_WORKER=external; by default the API runs the runner itself.
import 'dotenv/config';
import { startBookingWorker } from './runner.js';

const stop = startBookingWorker();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stop(); setTimeout(() => process.exit(0), 1_500); });
}
