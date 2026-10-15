CREATE TABLE IF NOT EXISTS "assistant"."nutrition_goals" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "assistant"."users"("id") ON DELETE cascade,
  "calories" integer DEFAULT 2100 NOT NULL,
  "protein_g" integer DEFAULT 150 NOT NULL,
  "fat_g" integer DEFAULT 70 NOT NULL,
  "carbs_g" integer DEFAULT 215 NOT NULL,
  "workout_percent" integer DEFAULT 50 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
