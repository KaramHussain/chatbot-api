// Drizzle table definitions for Bookings. DDL lives in ddl.ts (idempotent); these mirror it for typed queries.
import { boolean, date, integer, jsonb, pgTable, text, time, timestamp, uuid } from 'drizzle-orm/pg-core';

export interface Branding {
  logoUrl?: string | null;
  accent?: string | null;
  senderName?: string | null;
  replyTo?: string | null;
  signOff?: string | null;
  footer?: string | null;
}

export interface NotifyConfig {
  /** Extra owner/team recipients (the account owner's email is always included by default). */
  recipients?: string[];
  ownerNewBooking?: boolean;
  ownerChanges?: boolean;
  visitorConfirmation?: boolean;
  visitorChanges?: boolean;
  reminder24h?: boolean;
  reminder1h?: boolean;
  followUp?: boolean;
  followUpHours?: number;
  followUpMessage?: string | null;
  reviewUrl?: string | null;
  dailyAgenda?: boolean;
  weeklySummary?: boolean;
  confirmationMessage?: string | null;
  lastDailyOn?: string | null;
  lastWeeklyOn?: string | null;
}

export type QuestionType = 'text' | 'long_text' | 'single_choice' | 'multi_choice' | 'yes_no' | 'phone' | 'number' | 'date';
export interface IntakeQuestion {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  options?: string[];
}

export type BookingStatus =
  | 'held' | 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show' | 'expired' | 'declined';

export const bookingSettings = pgTable('booking_settings', {
  botId: uuid('bot_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  timezone: text('timezone').notNull().default('UTC'),
  slotIntervalMin: integer('slot_interval_min').notNull().default(30),
  windowDays: integer('window_days').notNull().default(60),
  minNoticeMin: integer('min_notice_min').notNull().default(120),
  dailyCap: integer('daily_cap'),
  offerMode: text('offer_mode').notNull().default('intent'),
  term: text('term').notNull().default('appointment'),
  requirePhone: boolean('require_phone').notNull().default(false),
  aiInstructions: text('ai_instructions'),
  whenFull: text('when_full').notNull().default('contact'),
  paused: boolean('paused').notNull().default(false),
  pauseMessage: text('pause_message'),
  timeFormat: text('time_format').notNull().default('12h'),
  weekStart: integer('week_start').notNull().default(1),
  notify: jsonb('notify').$type<NotifyConfig>().notNull().default({}),
  branding: jsonb('branding').$type<Branding>().notNull().default({}),
  feedTokenHash: text('feed_token_hash'),
  pageSlug: text('page_slug'),
  onboardingDoneAt: timestamp('onboarding_done_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const meetingTypes = pgTable('meeting_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  durationMin: integer('duration_min').notNull().default(30),
  locationType: text('location_type').notNull().default('later'),
  locationValue: text('location_value'),
  priceText: text('price_text'),
  bufferBeforeMin: integer('buffer_before_min').notNull().default(0),
  bufferAfterMin: integer('buffer_after_min').notNull().default(0),
  minNoticeMin: integer('min_notice_min'),
  windowDays: integer('window_days'),
  maxPerDay: integer('max_per_day'),
  slotIntervalMin: integer('slot_interval_min'),
  confirmation: text('confirmation').notNull().default('instant'),
  confirmationMessage: text('confirmation_message'),
  questions: jsonb('questions').$type<IntakeQuestion[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const availabilityRules = pgTable('availability_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  weekday: integer('weekday').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
});

export const availabilityOverrides = pgTable('availability_overrides', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  date: date('date').notNull(),
  closed: boolean('closed').notNull().default(true),
  ranges: jsonb('ranges').$type<Array<{ start: string; end: string }>>().notNull().default([]),
  note: text('note'),
});

export const availabilityBlocks = pgTable('availability_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bookingPeople = pgTable('booking_people', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  emailNorm: text('email_norm'),
  phoneNorm: text('phone_norm'),
  name: text('name'),
  email: text('email'),
  phone: text('phone'),
  timezone: text('timezone'),
  tags: text('tags').array().notNull().default([]),
  source: text('source').notNull().default('chat'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface AiSummary {
  intent?: string;
  keyFacts?: string[];
  questions?: string[];
  sentiment?: string;
}

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  meetingTypeId: uuid('meeting_type_id'),
  personId: uuid('person_id'),
  conversationId: uuid('conversation_id'),
  status: text('status').$type<BookingStatus>().notNull().default('held'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  blockStartsAt: timestamp('block_starts_at', { withTimezone: true }).notNull(),
  blockEndsAt: timestamp('block_ends_at', { withTimezone: true }).notNull(),
  typeName: text('type_name'),
  visitorName: text('visitor_name'),
  visitorEmail: text('visitor_email'),
  visitorPhone: text('visitor_phone'),
  visitorTz: text('visitor_tz'),
  answers: jsonb('answers').$type<Record<string, string>>().notNull().default({}),
  source: text('source').notNull().default('chat'),
  locationSnapshot: jsonb('location_snapshot').$type<{ type?: string; value?: string | null }>().notNull().default({}),
  aiSummary: jsonb('ai_summary').$type<AiSummary | null>(),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  icsUid: text('ics_uid').notNull(),
  icsSequence: integer('ics_sequence').notNull().default(0),
  manageTokenHash: text('manage_token_hash'),
  cancelReason: text('cancel_reason'),
  cancelledBy: text('cancelled_by'),
  outcomeNote: text('outcome_note'),
  tags: text('tags').array().notNull().default([]),
  externalEventId: text('external_event_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bookingNotes = pgTable('booking_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id'),
  personId: uuid('person_id'),
  botId: uuid('bot_id').notNull(),
  authorUserId: uuid('author_user_id'),
  authorName: text('author_name'),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bookingEvents = pgTable('booking_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id').notNull(),
  botId: uuid('bot_id').notNull(),
  type: text('type').notNull(),
  actor: text('actor').notNull().default('system'),
  actorUserId: uuid('actor_user_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const bookingOtps = pgTable('booking_otps', {
  id: uuid('id').primaryKey().defaultRandom(),
  botId: uuid('bot_id').notNull(),
  emailNorm: text('email_norm').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  ip: text('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bookingJobs = pgTable('booking_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  bookingId: uuid('booking_id'),
  botId: uuid('bot_id'),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  doneAt: timestamp('done_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailLog = pgTable('email_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  botId: uuid('bot_id').notNull(),
  bookingId: uuid('booking_id'),
  template: text('template').notNull(),
  recipient: text('recipient').notNull(),
  audience: text('audience').notNull().default('visitor'),
  subject: text('subject'),
  status: text('status').notNull().default('queued'),
  providerId: text('provider_id'),
  error: text('error'),
  jobId: uuid('job_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});
