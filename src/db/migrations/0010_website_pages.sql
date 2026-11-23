ALTER TABLE bot_documents ADD COLUMN IF NOT EXISTS website_data jsonb NOT NULL DEFAULT '{}'::jsonb;
