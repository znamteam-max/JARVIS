ALTER TABLE "assistant"."food_entries" ADD COLUMN IF NOT EXISTS "photo_key" text;--> statement-breakpoint
ALTER TABLE "assistant"."food_entries" ADD COLUMN IF NOT EXISTS "photo_status" text;
