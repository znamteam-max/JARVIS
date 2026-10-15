CREATE TABLE IF NOT EXISTS "assistant"."fitness_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "source" text NOT NULL,
  "external_id" text NOT NULL,
  "name" text NOT NULL,
  "sport_type" text NOT NULL,
  "start_at" timestamptz NOT NULL,
  "distance_m" integer DEFAULT 0 NOT NULL,
  "moving_time_s" integer DEFAULT 0 NOT NULL,
  "elapsed_time_s" integer DEFAULT 0 NOT NULL,
  "elevation_gain_m" integer DEFAULT 0 NOT NULL,
  "average_heartrate" integer,
  "max_heartrate" integer,
  "calories" integer,
  "training_load" integer,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "notified_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fitness_activities_source_external_idx"
  ON "assistant"."fitness_activities" ("source", "external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fitness_activities_user_start_idx"
  ON "assistant"."fitness_activities" ("user_id", "start_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."wellness_days" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "source" text NOT NULL,
  "day" text NOT NULL,
  "resting_hr" integer,
  "hrv" integer,
  "sleep_secs" integer,
  "sleep_score" integer,
  "steps" integer,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wellness_days_user_source_day_idx"
  ON "assistant"."wellness_days" ("user_id", "source", "day");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."integration_sync_state" (
  "key" text PRIMARY KEY NOT NULL,
  "last_sync_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
