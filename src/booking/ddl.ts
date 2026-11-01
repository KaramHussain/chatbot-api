// Idempotent DDL for the Bookings feature. Run from src/db/migrate.ts (and by the Docker test setup).
// Weekdays are ISO: 1 = Monday … 7 = Sunday. All instants are timestamptz (stored UTC).
// Local wall-clock times (availability rules) are plain `time` values in booking_settings.timezone.

export const BOOKING_DDL: string[] = [
  `CREATE EXTENSION IF NOT EXISTS btree_gist`,

  `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS feature_overrides jsonb DEFAULT '{}'::jsonb NOT NULL`,

  `CREATE TABLE IF NOT EXISTS booking_settings (
    bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    timezone text NOT NULL DEFAULT 'UTC',
    slot_interval_min integer NOT NULL DEFAULT 30,
    window_days integer NOT NULL DEFAULT 60,
    min_notice_min integer NOT NULL DEFAULT 120,
    daily_cap integer,
    offer_mode text NOT NULL DEFAULT 'intent',
    term text NOT NULL DEFAULT 'appointment',
    require_phone boolean NOT NULL DEFAULT false,
    ai_instructions text,
    when_full text NOT NULL DEFAULT 'contact',
    paused boolean NOT NULL DEFAULT false,
    pause_message text,
    time_format text NOT NULL DEFAULT '12h',
    week_start integer NOT NULL DEFAULT 1,
    notify jsonb NOT NULL DEFAULT '{}'::jsonb,
    branding jsonb NOT NULL DEFAULT '{}'::jsonb,
    feed_token_hash text,
    page_slug text,
    onboarding_done_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS booking_settings_feed_idx ON booking_settings (feed_token_hash) WHERE feed_token_hash IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS booking_settings_slug_idx ON booking_settings (page_slug) WHERE page_slug IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS meeting_types (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    duration_min integer NOT NULL DEFAULT 30,
    location_type text NOT NULL DEFAULT 'later',
    location_value text,
    price_text text,
    buffer_before_min integer NOT NULL DEFAULT 0,
    buffer_after_min integer NOT NULL DEFAULT 0,
    min_notice_min integer,
    window_days integer,
    max_per_day integer,
    slot_interval_min integer,
    confirmation text NOT NULL DEFAULT 'instant',
    confirmation_message text,
    questions jsonb NOT NULL DEFAULT '[]'::jsonb,
    active boolean NOT NULL DEFAULT true,
    sort integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS meeting_types_bot_slug_idx ON meeting_types (bot_id, slug)`,

  `CREATE TABLE IF NOT EXISTS availability_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    start_time time NOT NULL,
    end_time time NOT NULL CHECK (end_time > start_time)
  )`,
  `CREATE INDEX IF NOT EXISTS availability_rules_bot_idx ON availability_rules (bot_id)`,

  `CREATE TABLE IF NOT EXISTS availability_overrides (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    date date NOT NULL,
    closed boolean NOT NULL DEFAULT true,
    ranges jsonb NOT NULL DEFAULT '[]'::jsonb,
    note text,
    UNIQUE (bot_id, date)
  )`,

  `CREATE TABLE IF NOT EXISTS availability_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    reason text,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS availability_blocks_bot_idx ON availability_blocks (bot_id, starts_at)`,

  `CREATE TABLE IF NOT EXISTS booking_people (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email_norm text,
    phone_norm text,
    name text,
    email text,
    phone text,
    timezone text,
    tags text[] NOT NULL DEFAULT '{}',
    source text NOT NULL DEFAULT 'chat',
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS booking_people_email_idx ON booking_people (bot_id, email_norm) WHERE email_norm IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS booking_people_last_seen_idx ON booking_people (bot_id, last_seen_at DESC)`,

  `CREATE TABLE IF NOT EXISTS bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    meeting_type_id uuid REFERENCES meeting_types(id) ON DELETE SET NULL,
    person_id uuid REFERENCES booking_people(id) ON DELETE SET NULL,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'held'
      CHECK (status IN ('held','pending','confirmed','cancelled','completed','no_show','expired','declined')),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    block_starts_at timestamptz NOT NULL,
    block_ends_at timestamptz NOT NULL,
    type_name text,
    visitor_name text,
    visitor_email text,
    visitor_phone text,
    visitor_tz text,
    answers jsonb NOT NULL DEFAULT '{}'::jsonb,
    source text NOT NULL DEFAULT 'chat',
    location_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    ai_summary jsonb,
    hold_expires_at timestamptz,
    ics_uid text NOT NULL DEFAULT (gen_random_uuid()::text || '@cloudgeniee.com'),
    ics_sequence integer NOT NULL DEFAULT 0,
    manage_token_hash text,
    cancel_reason text,
    cancelled_by text,
    outcome_note text,
    tags text[] NOT NULL DEFAULT '{}',
    external_event_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
      bot_id WITH =,
      tstzrange(block_starts_at, block_ends_at, '[)') WITH &&
    ) WHERE (status IN ('held','pending','confirmed'))
  )`,
  `CREATE INDEX IF NOT EXISTS bookings_bot_start_idx ON bookings (bot_id, starts_at)`,
  `CREATE INDEX IF NOT EXISTS bookings_bot_status_idx ON bookings (bot_id, status, starts_at)`,
  `CREATE INDEX IF NOT EXISTS bookings_person_idx ON bookings (person_id)`,
  `CREATE INDEX IF NOT EXISTS bookings_conversation_idx ON bookings (conversation_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS bookings_manage_token_idx ON bookings (manage_token_hash) WHERE manage_token_hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS bookings_held_expiry_idx ON bookings (hold_expires_at) WHERE status = 'held'`,

  `CREATE TABLE IF NOT EXISTS booking_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id uuid REFERENCES bookings(id) ON DELETE CASCADE,
    person_id uuid REFERENCES booking_people(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    author_user_id uuid,
    author_name text,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS booking_notes_booking_idx ON booking_notes (booking_id)`,
  `CREATE INDEX IF NOT EXISTS booking_notes_person_idx ON booking_notes (person_id)`,

  `CREATE TABLE IF NOT EXISTS booking_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    type text NOT NULL,
    actor text NOT NULL DEFAULT 'system',
    actor_user_id uuid,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS booking_events_booking_idx ON booking_events (booking_id, at)`,
  `CREATE INDEX IF NOT EXISTS booking_events_bot_idx ON booking_events (bot_id, at DESC)`,

  `CREATE TABLE IF NOT EXISTS booking_otps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    email_norm text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    consumed_at timestamptz,
    ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS booking_otps_lookup_idx ON booking_otps (bot_id, email_norm, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS booking_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL,
    booking_id uuid REFERENCES bookings(id) ON DELETE CASCADE,
    bot_id uuid REFERENCES bots(id) ON DELETE CASCADE,
    run_at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    locked_at timestamptz,
    done_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS booking_jobs_due_idx ON booking_jobs (run_at) WHERE done_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS booking_jobs_booking_idx ON booking_jobs (booking_id) WHERE done_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS email_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
    template text NOT NULL,
    recipient text NOT NULL,
    audience text NOT NULL DEFAULT 'visitor',
    subject text,
    status text NOT NULL DEFAULT 'queued',
    provider_id text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
  )`,
  `ALTER TABLE email_log ADD COLUMN IF NOT EXISTS job_id uuid`,
  `CREATE INDEX IF NOT EXISTS email_log_job_idx ON email_log (job_id)`,
  `CREATE INDEX IF NOT EXISTS email_log_bot_idx ON email_log (bot_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS email_log_booking_idx ON email_log (booking_id)`,

  // Conversation → verified email (set only by the OTP flow; unlocks manage tools for that chat)
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS verified_email text`,
];
