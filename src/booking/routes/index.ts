// Owner API for Bookings, mounted at /api/bots/:id/booking (auth + plan check applied by the parent).
import { Hono } from 'hono';
import { botGuard, type BookingOwnerEnv } from './guard.js';
import settingsRouter from './settings.js';
import bookingsRouter from './bookings.js';

const router = new Hono<BookingOwnerEnv>();
router.use('*', botGuard);
router.route('/', settingsRouter);
router.route('/', bookingsRouter);

export default router;
