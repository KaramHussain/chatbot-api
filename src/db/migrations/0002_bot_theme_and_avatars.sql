ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "theme_name" text DEFAULT 'Amethyst';--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "user_bubble_color" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "bot_bubble_bg" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "launcher_size" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "widget_position" text DEFAULT 'bottom-right';--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "launcher_transparent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_avatar_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"image_url" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_avatar_presets_order_idx" ON "bot_avatar_presets" USING btree ("display_order");
