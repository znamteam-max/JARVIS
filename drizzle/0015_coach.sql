CREATE TABLE IF NOT EXISTS "assistant"."coach_profiles" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "profile" text NOT NULL,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."coach_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_messages_user_created_idx" ON "assistant"."coach_messages" ("user_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."ride_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "started_at" timestamptz NOT NULL,
  "file_name" text,
  "source" text DEFAULT 'upload' NOT NULL,
  "summary" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ride_files_user_started_idx" ON "assistant"."ride_files" ("user_id", "started_at");
