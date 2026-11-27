ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS window_size text DEFAULT 'standard' NOT NULL;
