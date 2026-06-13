-- Migration 0003: Tenant custom themes + new bot fields

CREATE TABLE IF NOT EXISTS "tenant_themes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "primary_color" text NOT NULL DEFAULT '#7c3aed',
  "user_bubble_color" text NOT NULL DEFAULT '#6d28d9',
  "bot_bubble_bg" text NOT NULL DEFAULT '#f5f3ff',
  "bot_text_color" text NOT NULL DEFAULT '#2e1065',
  "window_bg" text NOT NULL DEFAULT '#ffffff',
  "input_bg" text NOT NULL DEFAULT '#f8fafc',
  "header_logo_bg" text,
  "user_text" text NOT NULL DEFAULT '#ffffff',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tenant_themes_tenant_idx" ON "tenant_themes" USING btree ("tenant_id");

ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "header_logo_bg" text;
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "tenant_theme_id" uuid REFERENCES "tenant_themes"("id") ON DELETE SET NULL;
