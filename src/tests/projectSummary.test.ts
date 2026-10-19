import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createProjectsTestDb } from "./helpers/projectsTestDb";

const state = vi.hoisted(() => ({ db: null as unknown }));
const calls = vi.hoisted(() => ({
  askClaudeRelay: vi.fn(),
  isClaudeRelayConfigured: vi.fn(),
  canUseOpenAI: vi.fn(),
  createResponse: vi.fn(),
  writeAudit: vi.fn(),
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

import { getProject, insertProjectEntry } from "@/db/queries/projects";
import type { Project, ProjectEntry, User } from "@/db/schema";
import {
  buildProjectSummaryPrompt,
  cleanSummary,
  summarizeProject,
} from "@/services/projectSummary";
import { createProjectFromApp, getProjectView, updateProjectFromApp } from "@/services/projects";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const USER = { id: OWNER, timezone: "Europe/Moscow" } as User;

function project(overrides: Partial<Project>): Project {
  return {
    id: "p1",
    userId: OWNER,
    title: "Сайт для клиники",
    status: "active",
    waitingFor: null,
    summary: null,
    repo: null,
    lastActivityAt: new Date("2026-10-18T10:00:00Z"),
    metadata: {},
    createdAt: new Date("2026-10-01T10:00:00Z"),
    updatedAt: new Date("2026-10-18T10:00:00Z"),
    ...overrides,
  };
}

function entry(overrides: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: "e1",
    projectId: "p1",
    userId: OWNER,
    kind: "done",
    text: "Сделал",
    source: "manual",
    externalId: null,
    occurredAt: new Date("2026-10-18T10:00:00Z"),
    closedAt: null,
    metadata: {},
    createdAt: new Date("2026-10-18T10:00:00Z"),
    updatedAt: new Date("2026-10-18T10:00:00Z"),
    ...overrides,
  };
}

describe("what JARVIS reads before writing a summary", () => {
  const prompt = buildProjectSummaryPrompt({
    project: project({
      status: "waiting",
      waitingFor: "ответа заказчика",
      repo: "znamteam-max/clinic",
      summary: "Макет согласован.",
      metadata: { summarySource: "manual" },
    }),
    entries: [
      entry({
        id: "t2",
        kind: "todo",
        text: "Подключить оплату",
        occurredAt: new Date("2026-10-12T09:00:00Z"),
      }),
      entry({
        id: "t1",
        kind: "todo",
        text: "Сверстать главную",
        occurredAt: new Date("2026-10-10T09:00:00Z"),
      }),
      // 22:30 UTC on the 18th is already the 19th in Moscow.
      entry({
        id: "d1",
        text: "Fix booking form",
        source: "github",
        occurredAt: new Date("2026-10-18T22:30:00Z"),
      }),
      entry({
        id: "t0",
        kind: "todo",
        text: "Купить домен",
        occurredAt: new Date("2026-10-01T09:00:00Z"),
        closedAt: new Date("2026-10-15T09:00:00Z"),
      }),
      entry({ id: "n1", kind: "note", text: "Хостинг — у заказчика", source: "claude_code" }),
      entry({
        id: "long",
        kind: "note",
        text: "а".repeat(500),
        occurredAt: new Date("2026-10-02T09:00:00Z"),
      }),
    ],
    timezone: "Europe/Moscow",
    now: new Date("2026-10-19T09:00:00Z"),
  });

  it("has the project, its status and what it waits for", () => {
    expect(prompt).toContain("Сегодня: 19.10.2026");
    expect(prompt).toContain("Проект: Сайт для клиники");
    expect(prompt).toContain("Статус: ждёт");
    expect(prompt).toContain("Ждём: ответа заказчика");
    expect(prompt).toContain("Репозиторий: znamteam-max/clinic");
  });

  it("keeps the owner's own summary and says who wrote it", () => {
    expect(prompt).toContain("Прежняя сводка (написал владелец):\nМакет согласован.");
  });

  it("lists ahead in planned order and done newest first, in the owner's time zone", () => {
    const ahead = prompt.slice(prompt.indexOf("Впереди (2)"), prompt.indexOf("Сделано ("));
    expect(ahead.indexOf("Сверстать главную")).toBeLessThan(ahead.indexOf("Подключить оплату"));
    const done = prompt.slice(prompt.indexOf("Сделано (2)"), prompt.indexOf("Заметки:"));
    expect(done).toContain("- 19.10.2026 [GitHub]: Fix booking form");
    // A ticked-off todo counts from the day it was done.
    expect(done).toContain("- 15.10.2026: Купить домен");
    expect(done.indexOf("Fix booking form")).toBeLessThan(done.indexOf("Купить домен"));
  });

  it("marks where a line came from and cuts very long ones", () => {
    expect(prompt).toContain("[Claude Code]: Хостинг — у заказчика");
    expect(prompt).not.toContain("а".repeat(301));
    expect(prompt).toContain(`${"а".repeat(299)}…`);
  });
});

describe("the summary as it is stored", () => {
  it("drops the markdown the model adds anyway", () => {
    expect(cleanSummary("```\n## Сводка\n**Сейчас:** вёрстка.\n\n\n\nДальше: оплата.\n```")).toBe(
      "Сводка\nСейчас: вёрстка.\n\nДальше: оплата.",
    );
  });
});

describe("«Обновить сводку»", () => {
  let pg: PGlite;

  beforeAll(async () => {
    const test = await createProjectsTestDb([OWNER, OTHER]);
    pg = test.pg;
    state.db = test.db;
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec("delete from assistant.projects");
    for (const fn of Object.values(calls)) fn.mockReset();
    calls.isClaudeRelayConfigured.mockReturnValue(true);
    calls.canUseOpenAI.mockReturnValue(true);
    calls.writeAudit.mockResolvedValue(undefined);
  });

  async function projectWithLog() {
    const created = await createProjectFromApp({ userId: OWNER, title: "JARVIS" });
    await insertProjectEntry({
      userId: OWNER,
      projectId: created.id,
      kind: "done",
      text: "Вкладка «Проекты»",
    });
    await insertProjectEntry({
      userId: OWNER,
      projectId: created.id,
      kind: "todo",
      text: "Сводка от JARVIS",
    });
    return created;
  }

  it("Claude writes it, and the card says who and when, without counting it as progress", async () => {
    const created = await projectWithLog();
    const before = await getProject(OWNER, created.id);
    calls.askClaudeRelay.mockResolvedValue({
      result: "Сейчас: вкладка готова.\nДальше: сводка от JARVIS.",
      structured: null,
      model: "claude-opus-5-5",
    });

    const view = await summarizeProject({ user: USER, projectId: created.id });

    expect(calls.askClaudeRelay.mock.calls[0][0].prompt).toContain("Сводка от JARVIS");
    expect(calls.createResponse).not.toHaveBeenCalled();
    expect(view).toMatchObject({
      summary: "Сейчас: вкладка готова.\nДальше: сводка от JARVIS.",
      summaryBy: "ai",
      summaryModel: "Claude Opus 5.5",
      summaryStale: false,
    });
    const after = await getProject(OWNER, created.id);
    expect(after?.lastActivityAt.getTime()).toBe(before?.lastActivityAt.getTime());
    expect(after?.metadata).toMatchObject({ summarySource: "ai", summaryEngine: "claude" });
  });

  it("a new entry after the summary marks it stale", async () => {
    const created = await projectWithLog();
    calls.askClaudeRelay.mockResolvedValue({
      result: "Сейчас: ок.",
      structured: null,
      model: null,
    });
    await summarizeProject({ user: USER, projectId: created.id });
    // Timestamps compare by the millisecond: make sure the new line is later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await insertProjectEntry({
      userId: OWNER,
      projectId: created.id,
      kind: "done",
      text: "Ещё шаг",
    });
    expect((await getProjectView(OWNER, created.id)).summaryStale).toBe(true);
  });

  it("when Claude is down, OpenAI writes it and the card says it was the fallback", async () => {
    const created = await projectWithLog();
    calls.askClaudeRelay.mockRejectedValue(new Error("relay_http_502"));
    calls.createResponse.mockResolvedValue({
      output_text: "Сейчас: вкладка готова.",
      model: "gpt-4o-mini-2024-07-18",
      usage: { input_tokens: 400, output_tokens: 40, total_tokens: 440 },
    });

    const view = await summarizeProject({ user: USER, projectId: created.id });

    expect(view.summaryModel).toBe("GPT-4o mini (запасной)");
    expect(calls.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assistant.openai_usage",
        details: expect.objectContaining({ capability: "project_summary", totalTokens: 440 }),
      }),
    );
  });

  it("an empty project is not sent to the model", async () => {
    const created = await createProjectFromApp({ userId: OWNER, title: "Пусто" });
    await expect(summarizeProject({ user: USER, projectId: created.id })).rejects.toMatchObject({
      code: "nothing_to_summarize",
    });
    expect(calls.askClaudeRelay).not.toHaveBeenCalled();
  });

  it("with no model reachable the owner gets a clear failure and the summary stays", async () => {
    const created = await projectWithLog();
    await updateProjectFromApp({ userId: OWNER, projectId: created.id, summary: "Моя сводка" });
    calls.isClaudeRelayConfigured.mockReturnValue(false);
    calls.canUseOpenAI.mockReturnValue(false);
    await expect(summarizeProject({ user: USER, projectId: created.id })).rejects.toMatchObject({
      code: "summary_failed",
    });
    expect(await getProjectView(OWNER, created.id)).toMatchObject({
      summary: "Моя сводка",
      summaryBy: "manual",
    });
  });

  it("another user's project is not found", async () => {
    const created = await projectWithLog();
    await expect(
      summarizeProject({ user: { ...USER, id: OTHER }, projectId: created.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(calls.askClaudeRelay).not.toHaveBeenCalled();
  });
});
