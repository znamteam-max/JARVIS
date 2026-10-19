import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ALWAYS_EXCLUDED,
  buildReport,
  cleanUserText,
  isExcluded,
  lastTurn,
  repoFromRemote,
} from "../../ops/claude-code/jarvis-report.mjs";

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { role: "assistant", content }, ...extra });

const TRANSCRIPT = [
  user("Сделай вкладку проектов"),
  assistant([{ type: "text", text: "Старый ответ" }]),
  line({ type: "attachment", attachment: {} }),
  user([
    { type: "text", text: "<system-reminder>\nскрытый контекст\n</system-reminder>" },
    { type: "text", text: "Теперь фаза 4" },
  ]),
  assistant([{ type: "thinking", thinking: "думаю" }]),
  assistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
  user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
  user([{ type: "text", text: "skill text" }], { isMeta: true }),
  assistant([{ type: "text", text: "Пишу хук." }]),
  assistant([{ type: "text", text: "subagent chatter" }], { isSidechain: true }),
  user("subagent prompt", { isSidechain: true }),
  assistant([{ type: "text", text: "Готово: хук отправляет отчёт." }]),
  // The line Claude Code is still writing.
  '{"type":"assistant","message":{"content":[{"type":"te',
];

describe("the turn the hook reports", () => {
  it("is the owner's last real message and every reply text after it", () => {
    expect(lastTurn(TRANSCRIPT)).toEqual({
      userText: "Теперь фаза 4",
      assistantText: "Пишу хук.\n\nГотово: хук отправляет отчёт.",
    });
  });

  it("a slash command keeps its name and arguments, without the tags", () => {
    expect(
      cleanUserText(
        "<command-message>ecc:plan</command-message>\n<command-name>/ecc:plan</command-name>\n<command-args>статус проектов</command-args>",
      ),
    ).toBe("/ecc:plan\nстатус проектов");
  });

  it("a session with no reply yet has nothing to send", () => {
    expect(lastTurn([user("Привет")])).toEqual({ userText: "Привет", assistantText: "" });
  });
});

describe("the repo a session works in", () => {
  it.each([
    ["https://github.com/znamteam-max/JARVIS.git", "znamteam-max/JARVIS"],
    ["git@github.com:some-org/Some-Project.git", "some-org/Some-Project"],
    ["https://github.com/other-org/Another-Project", "other-org/Another-Project"],
    ["https://gitlab.com/a/b.git", null],
    [null, null],
  ])("%s → %s", (remote, repo) => {
    expect(repoFromRemote(remote)).toBe(repo);
  });
});

describe("the report the hook would send", () => {
  let root: string;
  let outside: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore", windowsHide: true });
  const read = () => TRANSCRIPT.join("\n");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "jarvis-hook-"));
    outside = mkdtempSync(join(tmpdir(), "jarvis-hook-plain-"));
    git("init", "-q");
    git("checkout", "-q", "-b", "feature/projects-status");
    git("remote", "add", "origin", "git@github.com:znamteam-max/JARVIS.git");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("carries the session, repo, folder, branch and the turn", () => {
    expect(buildReport({ session_id: "s1", transcript_path: "t.jsonl", cwd: root }, read)).toEqual({
      sessionId: "s1",
      repo: "znamteam-max/JARVIS",
      folder: basename(root),
      branch: "feature/projects-status",
      userMessage: "Теперь фаза 4",
      assistantMessage: "Пишу хук.\n\nГотово: хук отправляет отчёт.",
    });
  });

  it("stays quiet outside git, in an opted-out repo, or when Claude Code re-runs the hook", () => {
    expect(buildReport({ session_id: "s1", transcript_path: "t", cwd: outside }, read)).toBeNull();
    expect(
      buildReport(
        { session_id: "s1", transcript_path: "t", cwd: root, stop_hook_active: true },
        read,
      ),
    ).toBeNull();
    writeFileSync(join(root, ".jarvis-ignore"), "");
    expect(buildReport({ session_id: "s1", transcript_path: "t", cwd: root }, read)).toBeNull();
    rmSync(join(root, ".jarvis-ignore"));
  });

  it("an RNGN repo is skipped before its transcript is even read", () => {
    git("remote", "set-url", "origin", "https://github.com/RNGN-Home-of-Hockey/BOLSHE-Live-Center");
    const reads: string[] = [];
    const tracked = (path: string) => {
      reads.push(path);
      return read();
    };
    try {
      expect(
        buildReport({ session_id: "s1", transcript_path: "t", cwd: root }, tracked),
      ).toBeNull();
      // Even an empty config list keeps the default.
      expect(
        buildReport({ session_id: "s1", transcript_path: "t", cwd: root }, tracked, [
          ...ALWAYS_EXCLUDED,
        ]),
      ).toBeNull();
      expect(reads).toEqual([]);
    } finally {
      git("remote", "set-url", "origin", "git@github.com:znamteam-max/JARVIS.git");
    }
  });
});

describe("which projects never report", () => {
  it.each([
    ["RNGN-Autopost/Bolshe-Autopost-Frontend", "Bolshe-Autopost-Frontend"],
    ["RNGN-Home-of-Hockey/HOH_NHL_Daily_Results", "HOH_NHL_Daily_Results-epl"],
    ["znamteam-max/RNGN-HoH-Highlights", "RNGN-HoH-Highlights-nba"],
    [null, "RNGN_STUDIO"],
    [null, "rngn-local"],
  ])("RNGN work: %s in %s", (repo, folder) => {
    expect(isExcluded(ALWAYS_EXCLUDED, { repo, folder })).toBe(true);
  });

  it.each([
    ["znamteam-max/JARVIS", "JARVIS"],
    ["znamteam-max/TENNIS-Scores_daily_results", "TENNIS-Scores_daily_results"],
    [null, "ZNAMBO-Calls"],
  ])("own projects still report: %s in %s", (repo, folder) => {
    expect(isExcluded(ALWAYS_EXCLUDED, { repo, folder })).toBe(false);
  });

  it("extra patterns from the config work the same way, dots taken literally", () => {
    expect(isExcluded(["*-private"], { repo: "me/notes-private", folder: "notes" })).toBe(true);
    expect(isExcluded(["a.b"], { repo: null, folder: "axb" })).toBe(false);
  });
});
