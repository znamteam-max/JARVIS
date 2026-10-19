import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createProjectsTestDb } from "./helpers/projectsTestDb";

const OWNER = "00000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({ db: null as unknown }));
const calls = vi.hoisted(() => ({
  askClaudeRelay: vi.fn(),
  isClaudeRelayConfigured: vi.fn(),
  canUseOpenAI: vi.fn(),
  createResponse: vi.fn(),
  writeAudit: vi.fn(),
  getUserByTelegramId: vi.fn(),
}));

vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/ai/claudeRelay", () => ({
  askClaudeRelay: calls.askClaudeRelay,
  isClaudeRelayConfigured: calls.isClaudeRelayConfigured,
}));
vi.mock("@/ai/openaiClient", () => ({
  canUseOpenAI: calls.canUseOpenAI,
  getOpenAIClient: () => ({ responses: { create: calls.createResponse } }),
}));
vi.mock("@/db/queries/audit", () => ({ writeAudit: calls.writeAudit }));
vi.mock("@/db/queries/users", () => ({ getUserByTelegramId: calls.getUserByTelegramId }));

import { claimDueSessionReports } from "@/db/queries/projectSessionReports";
import { getProject } from "@/db/queries/projects";
import { resetEnvCacheForTests } from "@/lib/env";
import {
  parseSessionReport,
  processDueSessionReports,
  processSessionReport,
  receiveSessionReport,
  redactSecrets,
} from "@/services/projectSessionReports";
import {
  createProjectFromApp,
  editProjectEntryFromApp,
  getProjectView,
  listProjectsView,
} from "@/services/projects";

const T0 = new Date("2026-10-19T09:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

function report(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    repo: "znamteam-max/JARVIS",
    folder: "JARVIS",
    branch: "feature/projects-status",
    userMessage: "Сделай фазу 4",
    assistantMessage: "Готово: хук и эндпоинт. Дальше — поставить хук.",
    ...overrides,
  } as Parameters<typeof receiveSessionReport>[0];
}

function claudeAnswers(...answers: Array<{ done: string; next: string[] }>) {
  for (const answer of answers) {
    calls.askClaudeRelay.mockResolvedValueOnce({
      result: null,
      structured: answer,
      model: "claude-sonnet-5-5",
    });
  }
}

describe("what is never stored", () => {
  it("secrets in the session text are redacted", () => {
    const text = [
      "ключ sk-proj-abcdefghijklmnop1234",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      "DATABASE_URL=postgres://user:pass@host/db",
      "PROJECT_REPORT_TOKEN=very-secret-value",
      "бот 1234567890:AAEabcdefghijklmnopqrstuvwxyz0123456",
    ].join("\n");
    const clean = redactSecrets(text);
    for (const secret of [
      "sk-proj-abcdefghijklmnop1234",
      "github_pat_11ABCDEFG",
      "ghp_abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9",
      "user:pass@host",
      "very-secret-value",
      "AAEabcdefghij",
    ]) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain("PROJECT_REPORT_TOKEN=[redacted]");
  });

  it("the model's answer is trimmed to a few clean steps", () => {
    expect(
      parseSessionReport({
        done: "  Сделал   хук.\n",
        next: ["Поставить хук", "поставить  хук", "", "a", "b", "c", "d", "e"],
      }),
    ).toEqual({ done: "Сделал хук.", next: ["Поставить хук", "a", "b", "c", "d"] });
    expect(() => parseSessionReport({ done: 1 })).toThrow("report_unparsed");
  });
});

describe("Claude Code reports in the project log", () => {
  let pg: PGlite;

  beforeAll(async () => {
    const test = await createProjectsTestDb([OWNER]);
    pg = test.pg;
    state.db = test.db;
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec("delete from assistant.projects");
    for (const fn of Object.values(calls)) fn.mockReset();
    calls.getUserByTelegramId.mockResolvedValue({ id: OWNER, timezone: "Europe/Moscow" });
    calls.isClaudeRelayConfigured.mockReturnValue(true);
    calls.canUseOpenAI.mockReturnValue(false);
    calls.writeAudit.mockResolvedValue(undefined);
  });

  async function storedReport() {
    const rows = await pg.query<{ payload: Record<string, unknown> | null; done: string | null }>(
      "select payload, done from assistant.project_session_reports",
    );
    return rows.rows[0];
  }

  it("a session in a new repo starts its project; the next one finds it by repo", async () => {
    const first = await receiveSessionReport(report(), T0);
    expect(first).toMatchObject({ projectTitle: "JARVIS", created: true });
    const second = await receiveSessionReport(
      report({ sessionId: "session-2", folder: "jarvis-worktree", repo: "ZNAMTEAM-MAX/jarvis" }),
      T0,
    );
    expect(second).toMatchObject({ projectId: first?.projectId, created: false });
    const project = await getProject(OWNER, first!.projectId);
    expect(project).toMatchObject({ title: "JARVIS", repo: "znamteam-max/JARVIS" });
  });

  it("without a repo the folder name finds a project the owner made by hand", async () => {
    const manual = await createProjectFromApp({ userId: OWNER, title: "ZNAMBO-Calls" });
    const stored = await receiveSessionReport(report({ repo: null, folder: "znambo-calls" }), T0);
    expect(stored).toMatchObject({ projectId: manual.id, created: false });
  });

  it("the stored text is already redacted", async () => {
    await receiveSessionReport(
      report({ userMessage: "токен ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
      T0,
    );
    expect((await storedReport()).payload?.userMessage).toBe("токен [redacted]");
  });

  it("a burst of turns waits until the session is quiet, then becomes one model call", async () => {
    await receiveSessionReport(report({ assistantMessage: "Ход 1" }), T0);
    await receiveSessionReport(report({ assistantMessage: "Ход 2" }), after(30_000));
    expect(await processDueSessionReports(after(60_000))).toEqual({ processed: 0 });

    claudeAnswers({ done: "Сделал хук и эндпоинт.", next: ["Поставить хук"] });
    expect(await processDueSessionReports(after(30_000 + 91_000))).toEqual({ processed: 1 });
    expect(calls.askClaudeRelay).toHaveBeenCalledTimes(1);
    expect(calls.askClaudeRelay.mock.calls[0][0].prompt).toContain("Ход 2");
    expect(calls.askClaudeRelay.mock.calls[0][0].model).toBe("sonnet");

    // Nothing new: the next tick does nothing.
    expect(await processDueSessionReports(after(10 * 60_000))).toEqual({ processed: 0 });
  });

  it("one growing 'done' line per session and its open steps, kept in step with the session", async () => {
    const { projectId } = (await receiveSessionReport(report(), T0))!;
    claudeAnswers({
      done: "Сделал хук и эндпоинт.",
      next: ["Поставить хук", "Задать токен в Vercel", "Накатить миграцию"],
    });
    await processDueSessionReports(after(91_000));

    let view = await getProjectView(OWNER, projectId);
    expect(view.done.map((row) => [row.text, row.source])).toEqual([
      ["Сделал хук и эндпоинт.", "claude_code"],
    ]);
    expect(view.ahead.map((row) => row.text)).toEqual([
      "Поставить хук",
      "Задать токен в Vercel",
      "Накатить миграцию",
    ]);
    // The raw text is gone once processed; what the session reported stays.
    expect(await storedReport()).toEqual({ payload: null, done: "Сделал хук и эндпоинт." });

    // The owner ticks one step off by hand; the session goes on.
    const vercel = view.ahead.find((row) => row.text === "Задать токен в Vercel")!;
    await editProjectEntryFromApp({ userId: OWNER, entryId: vercel.id, done: true });
    await receiveSessionReport(report({ assistantMessage: "Хук поставлен." }), after(5 * 60_000));
    claudeAnswers({
      done: "Сделал хук и эндпоинт, поставил хук.",
      next: ["Задать токен в Vercel", "Проверить первый отчёт"],
    });
    await processDueSessionReports(after(7 * 60_000));

    view = await getProjectView(OWNER, projectId);
    expect(calls.askClaudeRelay.mock.calls[1][0].prompt).toContain(
      "Сделано: Сделал хук и эндпоинт.",
    );
    const sessionDone = view.done.filter((row) => row.kind === "done");
    expect(sessionDone.map((row) => row.text)).toEqual(["Сделал хук и эндпоинт, поставил хук."]);
    // Dropped open steps go, new ones come, the ticked-off one stays done.
    expect(view.ahead.map((row) => row.text)).toEqual(["Проверить первый отчёт"]);
    expect(view.done.some((row) => row.text === "Задать токен в Vercel" && row.closed)).toBe(true);
  });

  it("an empty 'done' from the model keeps what the session already reported", async () => {
    const { projectId } = (await receiveSessionReport(report(), T0))!;
    claudeAnswers({ done: "Сделал хук.", next: [] }, { done: "", next: ["Обсудить имя"] });
    await processDueSessionReports(after(91_000));
    await receiveSessionReport(
      report({ assistantMessage: "Вопрос: как назвать?" }),
      after(3 * 60_000),
    );
    await processDueSessionReports(after(5 * 60_000));
    const view = await getProjectView(OWNER, projectId);
    expect(view.done.map((row) => row.text)).toEqual(["Сделал хук."]);
    expect(view.ahead.map((row) => row.text)).toEqual(["Обсудить имя"]);
  });

  it("a turn that lands while the model is writing is processed on the next tick", async () => {
    await receiveSessionReport(report({ assistantMessage: "Ход 1" }), T0);
    const [claimed] = await claimDueSessionReports({
      now: after(91_000),
      quietMs: 90_000,
      maxWaitMs: 15 * 60_000,
      staleClaimMs: 5 * 60_000,
      maxAttempts: 5,
      limit: 2,
    });
    await receiveSessionReport(report({ assistantMessage: "Ход 2" }), after(95_000));
    claudeAnswers({ done: "Ход 1.", next: [] }, { done: "Ход 1 и 2.", next: [] });
    await processSessionReport(claimed, after(100_000));
    expect((await storedReport()).payload?.assistantMessage).toBe("Ход 2");

    expect(await processDueSessionReports(after(4 * 60_000))).toEqual({ processed: 1 });
    expect(await storedReport()).toEqual({ payload: null, done: "Ход 1 и 2." });
  });

  it("with no model the report waits and is retried a few times, then left alone", async () => {
    await receiveSessionReport(report(), T0);
    calls.isClaudeRelayConfigured.mockReturnValue(false);
    for (let tick = 1; tick <= 6; tick += 1) {
      await processDueSessionReports(after(tick * 2 * 60_000));
    }
    const row = await pg.query<{ attempts: number; last_error: string; claimed_at: Date | null }>(
      "select attempts, last_error, claimed_at from assistant.project_session_reports",
    );
    expect(row.rows[0]).toEqual({ attempts: 5, last_error: "no_model", claimed_at: null });
    expect((await listProjectsView(OWNER))[0].lastDone).toBeNull();
  });

  it("when Claude is down OpenAI reads the session", async () => {
    const { projectId } = (await receiveSessionReport(report(), T0))!;
    calls.askClaudeRelay.mockRejectedValue(new Error("relay_http_502"));
    calls.canUseOpenAI.mockReturnValue(true);
    calls.createResponse.mockResolvedValue({
      output_text: JSON.stringify({ done: "Сделал хук.", next: [] }),
      model: "gpt-4o-mini",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
    await processDueSessionReports(after(91_000));
    expect(calls.createResponse.mock.calls[0][0].text.format).toMatchObject({
      type: "json_schema",
      strict: true,
    });
    expect((await getProjectView(OWNER, projectId)).done[0].text).toBe("Сделал хук.");
  });
});

describe("the report endpoint", () => {
  beforeEach(() => {
    process.env.PROJECT_REPORT_TOKEN = "report-token";
    resetEnvCacheForTests();
  });

  afterEach(() => {
    delete process.env.PROJECT_REPORT_TOKEN;
    resetEnvCacheForTests();
  });

  async function post(body: unknown, token?: string) {
    const { POST } = await import("@/app/api/projects/session-report/route");
    return POST(
      new Request("http://localhost/api/projects/session-report", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  it("refuses a wrong token, and is off without one configured", async () => {
    expect((await post(report(), "wrong")).status).toBe(401);
    expect((await post(report())).status).toBe(401);
    delete process.env.PROJECT_REPORT_TOKEN;
    resetEnvCacheForTests();
    expect((await post(report(), "report-token")).status).toBe(503);
  });

  it("rejects a report without the reply text", async () => {
    expect((await post(report({ assistantMessage: "" }), "report-token")).status).toBe(400);
  });
});
