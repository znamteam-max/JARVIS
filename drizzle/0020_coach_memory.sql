CREATE TABLE IF NOT EXISTS "assistant"."coach_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
	"fact" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coach_memories_user_status_idx" ON "assistant"."coach_memories" USING btree ("user_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assistant"."health_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
	"taken_on" date,
	"lab" text,
	"title" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_records_user_taken_idx" ON "assistant"."health_records" USING btree ("user_id", "taken_on");
