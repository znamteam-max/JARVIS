#!/usr/bin/env node
// Claude Code Stop hook: sends the turn that just finished to JARVIS, which turns it into
// the project's log ("Сделано" / "Впереди"). It never blocks or fails a session: any
// problem ends quietly with exit 0 and no output.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 4000;
const MAX_USER_CHARS = 4000;
const MAX_ASSISTANT_CHARS = 20000;

// "https://github.com/owner/name.git" or "git@github.com:owner/name.git" → "owner/name".
export function repoFromRemote(remote) {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec((remote ?? "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// What the owner actually typed: no system reminders; a slash command keeps its name and
// arguments.
export function cleanUserText(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<\/?(?:command-name|command-args)>/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The last thing the owner asked in the main conversation and everything Claude wrote
// back after it (tool calls and their results left out).
export function lastTurn(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // a half-written last line
    }
  }
  let start = -1;
  let userText = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "user" || entry.isMeta || entry.isSidechain) continue;
    const text = cleanUserText(textOf(entry.message?.content));
    if (text) {
      start = index;
      userText = text;
      break;
    }
  }
  const assistantText = entries
    .slice(start + 1)
    .filter((entry) => entry.type === "assistant" && !entry.isSidechain)
    .map((entry) => textOf(entry.message?.content).trim())
    .filter(Boolean)
    .join("\n\n");
  return { userText, assistantText };
}

// JARVIS_REPORT_URL + JARVIS_REPORT_TOKEN, or ~/.claude/jarvis-report.json {url, token}.
function readConfig() {
  const url = process.env.JARVIS_REPORT_URL;
  const token = process.env.JARVIS_REPORT_TOKEN;
  if (url && token) return { url, token };
  try {
    const file = JSON.parse(readFileSync(join(homedir(), ".claude", "jarvis-report.json"), "utf8"));
    if (file?.url && file?.token) return { url: file.url, token: file.token };
  } catch {
    // not set up: reports are off
  }
  return null;
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// The report for one finished turn, or null when there is nothing to send: not a git
// project, opted out with a .jarvis-ignore file, or no reply text yet.
export function buildReport(input, readFile = (path) => readFileSync(path, "utf8")) {
  if (input.stop_hook_active || !input.session_id || !input.transcript_path) return null;
  const root = git(input.cwd || process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (!root || existsSync(join(root, ".jarvis-ignore"))) return null;
  const { userText, assistantText } = lastTurn(readFile(input.transcript_path).split("\n"));
  if (!assistantText) return null;
  // A branch name even before the first commit; null when detached.
  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return {
    sessionId: input.session_id,
    repo: repoFromRemote(git(root, ["remote", "get-url", "origin"])),
    folder: basename(root),
    branch: branch || null,
    userMessage: userText ? userText.slice(0, MAX_USER_CHARS) : null,
    assistantMessage: assistantText.slice(-MAX_ASSISTANT_CHARS),
  };
}

async function main() {
  const config = readConfig();
  if (!config) return;
  const report = buildReport(JSON.parse((await readStdin()) || "{}"));
  if (!report) return;
  await fetch(new URL("/api/projects/session-report", config.url), {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
