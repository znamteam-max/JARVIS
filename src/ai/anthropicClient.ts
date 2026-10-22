import Anthropic from "@anthropic-ai/sdk";

import { getEnv } from "@/lib/env";

// Claude by API key (Claude Console): the coach bot's athletes are answered here, on their
// own billing. The owner's JARVIS keeps using his Max subscription through the relay.
let client: Anthropic | null = null;

export class ClaudeApiError extends Error {}

function apiKey() {
  const env = getEnv();
  // The athlete's own key first; the generic name is only a fallback.
  return env.ANFISA_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || null;
}

export function isAnthropicConfigured() {
  return Boolean(apiKey());
}

export function getAnthropicClient() {
  const key = apiKey();
  if (!key) throw new ClaudeApiError("anthropic_not_configured");
  client ??= new Anthropic({ apiKey: key });
  return client;
}

// A wrong key, a revoked one or an empty balance: retrying will not help, a person must act.
export function isClaudeUnavailable(error: unknown) {
  if (error instanceof Anthropic.AuthenticationError) return true;
  if (error instanceof Anthropic.PermissionDeniedError) return true;
  if (error instanceof Anthropic.APIError && error.status === 402) return true;
  return (
    error instanceof Anthropic.BadRequestError && /credit|balance|billing/i.test(error.message)
  );
}

export type ClaudeContent = Anthropic.Beta.BetaContentBlockParam;

// One request whose answer must be JSON of the given schema (structured outputs). A
// safety decline is retried server-side on Anthropic's recommended fallback model. No
// client retries by default: the routes have 120 s, and a timeout must reach our own
// error handling instead of being retried past the limit.
export async function askClaudeJson<T>(params: {
  system: Array<{ text: string; cache?: boolean }>;
  content: string | ClaudeContent[];
  schema: Record<string, unknown>;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
}) {
  const response = await getAnthropicClient().beta.messages.create(
    {
      model: getEnv().ATHLETE_CLAUDE_MODEL,
      max_tokens: params.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: params.system.map((block) => ({
        type: "text" as const,
        text: block.text,
        ...(block.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
      })),
      messages: [{ role: "user", content: params.content }],
      output_config: {
        effort: params.effort ?? "medium",
        format: { type: "json_schema", schema: params.schema },
      },
    },
    { timeout: params.timeoutMs ?? 85_000, maxRetries: params.maxRetries ?? 0 },
  );
  if (response.stop_reason === "refusal") throw new ClaudeApiError("claude_refused");
  if (response.stop_reason === "max_tokens") throw new ClaudeApiError("claude_cut_off");
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new ClaudeApiError("claude_bad_json");
  }
  return { data, model: response.model, usage: response.usage };
}
