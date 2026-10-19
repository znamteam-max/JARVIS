// The Projects tables, exactly as drizzle/0018_projects.sql and
// drizzle/0019_project_session_reports.sql create them (a test keeps them in step).
// ensureProjectsSchema() runs them, so a deploy needs no manual migration for these tables.
export const PROJECTS_SCHEMA_FILES = [
  "0018_projects.sql",
  "0019_project_session_reports.sql",
] as const;

export const PROJECTS_SCHEMA_STATEMENTS: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS "assistant"."projects" (\n  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,\n  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,\n  "title" text NOT NULL,\n  "status" text DEFAULT \'active\' NOT NULL,\n  "waiting_for" text,\n  "summary" text,\n  "repo" text,\n  "last_activity_at" timestamptz DEFAULT now() NOT NULL,\n  "metadata" jsonb DEFAULT \'{}\'::jsonb NOT NULL,\n  "created_at" timestamptz DEFAULT now() NOT NULL,\n  "updated_at" timestamptz DEFAULT now() NOT NULL\n);',
  'CREATE INDEX IF NOT EXISTS "projects_user_activity_idx" ON "assistant"."projects" ("user_id", "last_activity_at");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "projects_user_repo_uq" ON "assistant"."projects" ("user_id", "repo") WHERE "repo" is not null;',
  'CREATE TABLE IF NOT EXISTS "assistant"."project_entries" (\n  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,\n  "project_id" uuid NOT NULL REFERENCES "assistant"."projects"("id") ON DELETE cascade,\n  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,\n  "kind" text NOT NULL,\n  "text" text NOT NULL,\n  "source" text DEFAULT \'manual\' NOT NULL,\n  "external_id" text,\n  "occurred_at" timestamptz DEFAULT now() NOT NULL,\n  "closed_at" timestamptz,\n  "metadata" jsonb DEFAULT \'{}\'::jsonb NOT NULL,\n  "created_at" timestamptz DEFAULT now() NOT NULL,\n  "updated_at" timestamptz DEFAULT now() NOT NULL\n);',
  'CREATE INDEX IF NOT EXISTS "project_entries_project_occurred_idx" ON "assistant"."project_entries" ("project_id", "occurred_at");',
  'CREATE UNIQUE INDEX IF NOT EXISTS "project_entries_source_external_uq" ON "assistant"."project_entries" ("project_id", "source", "external_id") WHERE "external_id" is not null;',
  'CREATE TABLE IF NOT EXISTS "assistant"."project_session_reports" (\n  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,\n  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,\n  "project_id" uuid NOT NULL REFERENCES "assistant"."projects"("id") ON DELETE cascade,\n  "session_id" text NOT NULL,\n  "payload" jsonb,\n  "payload_hash" text NOT NULL,\n  "received_at" timestamptz DEFAULT now() NOT NULL,\n  "claimed_at" timestamptz,\n  "processed_hash" text,\n  "processed_at" timestamptz,\n  "done" text,\n  "next" jsonb DEFAULT \'[]\'::jsonb NOT NULL,\n  "attempts" integer DEFAULT 0 NOT NULL,\n  "last_error" text,\n  "created_at" timestamptz DEFAULT now() NOT NULL,\n  "updated_at" timestamptz DEFAULT now() NOT NULL\n);',
  'CREATE UNIQUE INDEX IF NOT EXISTS "project_session_reports_user_session_uq" ON "assistant"."project_session_reports" ("user_id", "session_id");',
  'CREATE INDEX IF NOT EXISTS "project_session_reports_received_idx" ON "assistant"."project_session_reports" ("received_at");',
];
