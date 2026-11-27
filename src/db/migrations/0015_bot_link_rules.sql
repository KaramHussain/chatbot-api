CREATE TABLE IF NOT EXISTS public.bot_link_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  match_domain text NOT NULL,
  target_url text NOT NULL,
  label text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_link_rules_bot_domain_idx ON public.bot_link_rules (bot_id, match_domain);
