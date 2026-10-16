import { Container } from "@cloudflare/containers";

export interface Env {
  CLAUDE_RUNNER: DurableObjectNamespace<ClaudeRunner>;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  RELAY_TOKEN: string;
}

// One container with Claude Code on the owner's subscription. It sleeps when idle and
// wakes on the next request; the JARVIS app on Vercel is its only caller.
export class ClaudeRunner extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  entrypoint = ["node", "/app/server.mjs"];
  // Claude Code needs to reach Anthropic.
  enableInternet = true;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    this.envVars = {
      CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
      RELAY_TOKEN: env.RELAY_TOKEN,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
  }
}

function authorized(request: Request, env: Env) {
  if (!env.RELAY_TOKEN) return false;
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${env.RELAY_TOKEN}`);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

export default {
  async fetch(request: Request, env: Env) {
    if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
    return env.CLAUDE_RUNNER.getByName("main").fetch(request);
  },
};
