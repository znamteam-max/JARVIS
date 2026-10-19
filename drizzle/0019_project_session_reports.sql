CREATE TABLE IF NOT EXISTS "assistant"."project_session_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "project_id" uuid NOT NULL REFERENCES "assistant"."projects"("id") ON DELETE cascade,
  "session_id" text NOT NULL,
  "payload" jsonb,
  "payload_hash" text NOT NULL,
  "received_at" timestamptz DEFAULT now() NOT NULL,
  "claimed_at" timestamptz,
  "processed_hash" text,
  "processed_at" timestamptz,
  "done" text,
  "next" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_session_reports_user_session_uq" ON "assistant"."project_session_reports" ("user_id", "session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_session_reports_received_idx" ON "assistant"."project_session_reports" ("received_at");
