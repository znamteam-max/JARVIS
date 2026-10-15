CREATE TABLE IF NOT EXISTS "assistant"."food_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "source_message_id" uuid REFERENCES "assistant"."telegram_messages"("id") ON DELETE set null,
  "telegram_file_id" text,
  "caption" text,
  "title" text NOT NULL,
  "eaten_at" timestamptz NOT NULL,
  "calories" integer NOT NULL,
  "protein_g" integer NOT NULL,
  "fat_g" integer NOT NULL,
  "carbs_g" integer NOT NULL,
  "items" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "confidence" text NOT NULL,
  "model" text,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_entries_user_eaten_idx"
  ON "assistant"."food_entries" ("user_id", "eaten_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."strava_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "athlete_id" bigint NOT NULL,
  "athlete_name" text,
  "encrypted_access_token" text NOT NULL,
  "encrypted_refresh_token" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "scope" text,
  "status" text DEFAULT 'active' NOT NULL,
  "last_sync_at" timestamptz,
  "last_sync_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strava_connections_user_idx"
  ON "assistant"."strava_connections" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."strava_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "strava_id" bigint NOT NULL,
  "name" text NOT NULL,
  "sport_type" text NOT NULL,
  "start_at" timestamptz NOT NULL,
  "timezone" text,
  "distance_m" integer DEFAULT 0 NOT NULL,
  "moving_time_s" integer DEFAULT 0 NOT NULL,
  "elapsed_time_s" integer DEFAULT 0 NOT NULL,
  "elevation_gain_m" integer DEFAULT 0 NOT NULL,
  "average_heartrate" integer,
  "max_heartrate" integer,
  "calories" integer,
  "suffer_score" integer,
  "raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "notified_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strava_activities_strava_id_idx"
  ON "assistant"."strava_activities" ("strava_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strava_activities_user_start_idx"
  ON "assistant"."strava_activities" ("user_id", "start_at");
