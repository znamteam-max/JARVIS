import { getEnv } from "@/lib/env";

export class ClaudeRelayError extends Error {}

export function isClaudeRelayConfigured() {
  const env = getEnv();
  return Boolean(env.CLAUDE_RELAY_URL && env.CLAUDE_RELAY_TOKEN);
}

export type ClaudeRelayAnswer<T> = {
  result: string | null;
  structured: T | null;
  model: string | null;
};

// Claude Code on the owner's Max subscription, in a Cloudflare container
// (cloudflare-claude-worker/). Tools are off there: Claude only reads and answers,
// this app decides what actually happens.
export async function askClaudeRelay<T = unknown>(params: {
  system: string;
  prompt: string;
  schema?: Record<string, unknown>;
  model?: string;
  effort?: "low" | "medium" | "high";
  timeoutMs: number;
}): Promise<ClaudeRelayAnswer<T>> {
  const env = getEnv();
  if (!env.CLAUDE_RELAY_URL || !env.CLAUDE_RELAY_TOKEN) {
    throw new ClaudeRelayError("relay_not_configured");
  }
  const response = await fetch(`${env.CLAUDE_RELAY_URL.replace(/\/$/, "")}/ask`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CLAUDE_RELAY_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      system: params.system,
      prompt: params.prompt,
      schema: params.schema,
      model: params.model,
      effort: params.effort,
      timeoutMs: Math.max(5_000, params.timeoutMs - 3_000),
    }),
    signal: AbortSignal.timeout(params.timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) throw new ClaudeRelayError(`relay_http_${response.status}`);
  const body = (await response.json()) as {
    ok?: boolean;
    result?: string | null;
    structured?: T | null;
    model?: string | null;
    error?: string;
  };
  if (!body.ok) throw new ClaudeRelayError(body.error ?? "claude_failed");
  return {
    result: body.result ?? null,
    structured: body.structured ?? null,
    model: body.model ?? null,
  };
}
