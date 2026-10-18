ALTER TABLE "assistant"."users" ADD COLUMN IF NOT EXISTS "role" text DEFAULT 'owner' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."athlete_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"telegram_username" text,
	"first_name" text,
	"intervals_athlete_id" text,
	"intervals_api_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assistant"."athlete_connections" ADD CONSTRAINT "athlete_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "assistant"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "athlete_connections_telegram_user_uq" ON "assistant"."athlete_connections" USING btree ("telegram_user_id");
