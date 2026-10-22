import { DateTime } from "luxon";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  DEFAULT_TIMEZONE: z.string().default("Europe/Moscow"),
  OWNER_TIMEZONE: z.string().default("Europe/Moscow"),
  APP_ENCRYPTION_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  ALLOWED_TELEGRAM_USER_IDS: z.string().default(""),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TEXT_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_PLANNER_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_MEMORY_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE: z.coerce.boolean().default(true),
  ENABLE_MEMORY_EMBEDDINGS: z.coerce.boolean().default(false),
  ENABLE_AGENT_PLANNER_V2: z.coerce.boolean().default(true),
  JARVIS_MODE_ENABLED: z.coerce.boolean().default(true),
  SMART_COMMIT_MODE: z
    .enum(["confirm_all", "auto_low_risk", "auto_all_with_undo"])
    .default("auto_low_risk"),
  DEFAULT_MORNING_REMINDER_TIME: z.string().default("09:30"),
  CRON_SECRET: z.string().optional(),
  OPS_WATCHDOG_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default("http://localhost:3000/api/google/oauth/callback"),
  GOOGLE_CALENDAR_ID: z.string().default("primary"),
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  STRAVA_CLIENT_ID: z.string().optional(),
  STRAVA_CLIENT_SECRET: z.string().optional(),
  INTERVALS_API_KEY: z.string().optional(),
  INTERVALS_ATHLETE_ID: z.string().default("0"),
  COACH_MODEL: z.string().default("gpt-4.1"),
  // The coach bot's athletes (OpenAI only); falls back to COACH_MODEL.
  ATHLETE_COACH_MODEL: z.string().optional(),
  // The separate coach bot (e.g. @anfisakrasotka_strava_bot); unset = no coach bot.
  ATHLETE_BOT_TOKEN: z.string().optional(),
  // The same token under the name the owner gave it in Vercel.
  ANFISAKRASOTKA_BOT_TOKEN: z.string().optional(),
  // Claude by API key (Claude Console) for the coach bot's athletes: their own billing,
  // not the owner's Max subscription.
  ANTHROPIC_API_KEY: z.string().optional(),
  // The same key under the name the owner gave it in Vercel.
  ANFISA_ANTHROPIC_API_KEY: z.string().optional(),
  // Needed only for an organization-wide key (Claude Console, Scope: Organization).
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  ATHLETE_CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  // Claude Code on the owner's Max subscription in a Cloudflare container.
  CLAUDE_RELAY_URL: z.string().url().optional(),
  CLAUDE_RELAY_TOKEN: z.string().optional(),
  CLAUDE_CHAT_MODEL: z.string().default("opus"),
  CLAUDE_REVIEW_MODEL: z.string().default("opus"),
  // Turns Claude Code session reports into project log lines.
  CLAUDE_REPORT_MODEL: z.string().default("sonnet"),
  // Read-only GitHub tokens for the projects' commit log. A fine-grained token covers one
  // owner, so GITHUB_TOKENS maps owners to their tokens: "some-org=github_pat_...;...".
  // GITHUB_TOKEN is used for every other owner; public repos work without any token.
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_TOKENS: z.string().optional(),
  // Bearer token the Claude Code hook sends with its session reports; unset = reports off.
  PROJECT_REPORT_TOKEN: z.string().optional(),
  MEDIA_WORKER_URL: z.string().url().optional(),
  MEDIA_WORKER_TOKEN: z.string().optional(),
  CALENDAR_PROVIDER: z.enum(["none", "google", "yandex"]).default("none"),
  YANDEX_CALDAV_URL: z.string().url().default("https://caldav.yandex.ru"),
  YANDEX_CALDAV_USERNAME: z.string().optional(),
  YANDEX_CALDAV_APP_PASSWORD: z.string().optional(),
  YANDEX_CALDAV_CALENDAR_URL: z.string().url().optional(),
  YANDEX_CALENDAR_URL: z.string().url().optional(),
  CALDAV_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  CALDAV_READBACK_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  CALDAV_TOTAL_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
    validateTimezone("DEFAULT_TIMEZONE", cachedEnv.DEFAULT_TIMEZONE);
    validateTimezone("OWNER_TIMEZONE", cachedEnv.OWNER_TIMEZONE);
  }
  return cachedEnv;
}

export function resetEnvCacheForTests() {
  cachedEnv = null;
}

export function requireEnv<K extends keyof AppEnv>(key: K): NonNullable<AppEnv[K]> {
  const value = getEnv()[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${String(key)}`);
  }
  return value as NonNullable<AppEnv[K]>;
}

export function getAllowedTelegramUserIds(): Set<string> {
  return new Set(
    getEnv()
      .ALLOWED_TELEGRAM_USER_IDS.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function getOwnerTimezone(): string {
  return getEnv().OWNER_TIMEZONE;
}

function validateTimezone(name: string, timezone: string) {
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new Error(`Invalid ${name}: ${timezone}`);
  }
}

export function isGoogleCalendarConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

export function isStravaConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.APP_ENCRYPTION_KEY);
}

export function isIntervalsConfigured(): boolean {
  return Boolean(getEnv().INTERVALS_API_KEY);
}

export function isMediaStoreConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.MEDIA_WORKER_URL && env.MEDIA_WORKER_TOKEN);
}

export function isYandexCalendarConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.YANDEX_CALDAV_USERNAME && env.YANDEX_CALDAV_APP_PASSWORD);
}

export function getCalendarProvider(): "none" | "google" | "yandex" {
  const env = getEnv();
  if (env.CALENDAR_PROVIDER === "google" && isGoogleCalendarConfigured()) return "google";
  if (env.CALENDAR_PROVIDER === "yandex" && isYandexCalendarConfigured()) return "yandex";
  return "none";
}
