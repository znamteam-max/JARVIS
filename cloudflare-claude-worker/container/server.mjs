// Runs inside the Cloudflare container: one HTTP endpoint that asks Claude Code
// (headless, no tools, owner's subscription token) and returns its JSON answer.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const PORT = 8080;
const CLAUDE = "/usr/local/bin/claude";
const MAX_BODY = 4 * 1024 * 1024;
const MAX_PARALLEL = 2;
let running = 0;
const queue = [];

function authorized(header) {
  const expected = Buffer.from(`Bearer ${process.env.RELAY_TOKEN ?? ""}`);
  const given = Buffer.from(header ?? "");
  return (
    Boolean(process.env.RELAY_TOKEN) &&
    given.length === expected.length &&
    timingSafeEqual(given, expected)
  );
}

async function slot() {
  if (running < MAX_PARALLEL) {
    running += 1;
    return;
  }
  await new Promise((resolve) => queue.push(resolve));
  running += 1;
}

function release() {
  running -= 1;
  queue.shift()?.();
}

async function askClaude({ system, prompt, schema, model, effort, timeoutMs }) {
  const dir = await mkdtemp(join(tmpdir(), "ask-"));
  try {
    const systemFile = join(dir, "system.txt");
    await writeFile(systemFile, system ?? "");
    const args = [
      "-p",
      "--output-format",
      "json",
      "--system-prompt-file",
      systemFile,
      "--tools",
      "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--model",
      model || "sonnet",
    ];
    if (effort) args.push("--effort", effort);
    if (schema) args.push("--json-schema", JSON.stringify(schema));
    return await new Promise((resolve) => {
      const child = spawn(CLAUDE, args, { cwd: dir, env: process.env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs || 55_000);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            ok: !parsed.is_error,
            result: parsed.result ?? null,
            structured: parsed.structured_output ?? null,
            model: Object.keys(parsed.modelUsage ?? {})[0] ?? null,
            durationMs: parsed.duration_ms ?? null,
            usage: parsed.usage ?? null,
          });
        } catch {
          resolve({ ok: false, error: `exit ${code}`, stderr: stderr.slice(0, 500) });
        }
      });
      child.stdin.end(prompt ?? "");
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const server = http.createServer(async (request, response) => {
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.url === "/health") return send(200, { ok: true, running, queued: queue.length });
  if (!authorized(request.headers.authorization)) return send(401, { ok: false, error: "unauthorized" });
  if (request.method !== "POST" || request.url !== "/ask") return send(404, { ok: false });

  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY) return send(413, { ok: false, error: "too_large" });
  }
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return send(400, { ok: false, error: "invalid_json" });
  }
  await slot();
  try {
    send(200, await askClaude(input));
  } catch (error) {
    send(500, { ok: false, error: String(error?.message ?? error) });
  } finally {
    release();
  }
});

server.listen(PORT, () => console.log(`claude relay listening on ${PORT}`));
