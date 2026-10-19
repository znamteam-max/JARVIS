CREATE TABLE IF NOT EXISTS "assistant"."projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "waiting_for" text,
  "summary" text,
  "repo" text,
  "last_activity_at" timestamptz DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_user_activity_idx" ON "assistant"."projects" ("user_id", "last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_user_repo_uq" ON "assistant"."projects" ("user_id", "repo") WHERE "repo" is not null;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."project_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "assistant"."projects"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "text" text NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "external_id" text,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  "closed_at" timestamptz,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_entries_project_occurred_idx" ON "assistant"."project_entries" ("project_id", "occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_entries_source_external_uq" ON "assistant"."project_entries" ("project_id", "source", "external_id") WHERE "external_id" is not null;
