CREATE TABLE IF NOT EXISTS "assistant"."web_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "token_hash" text NOT NULL,
  "code" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "device" text,
  "approved_at" timestamptz,
  "last_seen_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "web_sessions_token_hash_uq" ON "assistant"."web_sessions" ("token_hash");
