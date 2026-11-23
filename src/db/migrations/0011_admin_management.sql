ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_idx" ON "users" ("username");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id" uuid NOT NULL,
  "tenant_id" uuid,
  "action" text NOT NULL,
  "resource" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_tenant_time_idx" ON "admin_audit_logs" ("tenant_id", "created_at");
