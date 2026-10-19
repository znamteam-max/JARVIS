import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createProjectsTestDb } from "./helpers/projectsTestDb";

const OWNER = "00000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({ db: null as unknown }));
const calls = vi.hoisted(() => ({
  askClaudeRelay: vi.fn(),
  isClaudeRelayConfigured: vi.fn(),
  getUserByTelegramId: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/ai/claudeRelay", () => ({
  askClaudeRelay: calls.askClaudeRelay,
  isClaudeRelayConfigured: calls.isClaudeRelayConfigured,
}));
vi.mock("@/ai/openaiClient", () => ({ canUseOpenAI: () => false, getOpenAIClient: vi.fn() }));
vi.mock("@/db/queries/audit", () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock("@/db/queries/users", () => ({
  getUserByTelegramId: calls.getUserByTelegramId,
  getUserById: calls.getUserById,
}));

import { getProject } from "@/db/queries/projects";
import type { Project } from "@/db/schema";
import { importProjects, isWorkProject } from "@/services/projectImport";
import { buildProjectSummaryPrompt, summarizeStaleProjects } from "@/services/projectSummary";
import {
  createProjectFromApp,
  getProjectView,
  listProjectsView,
  projectsContextBlock,
  summaryLine,
  updateProjectFromApp,
} from "@/services/projects";

const USER = { id: OWNER, timezone: "Europe/Moscow" };

function commit(sha: string, subject: string, date = "2026-10-18T10:00:00Z") {
  return { sha, subject, date };
}

describe("one line of where a project stands", () => {
  it("is the start of the summary without its label", () => {
    expect(summaryLine("Сейчас: вкладка готова, ждёт деплоя.\nСделано: схема.")).toBe(
      "вкладка готова, ждёт деплоя.",
    );
    expect(summaryLine("\n\nПроект почти пустой.")).toBe("Проект почти пустой.");
    expect(summaryLine(null)).toBeNull();
  });

  it("work projects are recognised by folder, owner or repo name", () => {
    expect(isWorkProject({ folder: "Bolshe", repo: "RNGN-Autopost/Bolshe" })).toBe(true);
    expect(isWorkProject({ folder: "RNGN_STUDIO", repo: null })).toBe(true);
    expect(isWorkProject({ folder: "JARVIS", repo: "znamteam-max/JARVIS" })).toBe(false);
  });
});

describe("what the summary reads besides the log", () => {
  it("includes the README and the computer's local state", () => {
    const prompt = buildProjectSummaryPrompt({
      project: {
        id: "p",
        userId: OWNER,
        title: "ZNAMBO-Voice",
        status: "active",
        waitingFor: null,
        summary: null,
        repo: null,
        lastActivityAt: new Date("2026-10-18T10:00:00Z"),
        metadata: {
          readme: "Голосовой помощник для звонков.",
          local: { git: true, branch: "main", dirty: 3 },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Project,
      entries: [],
      timezone: "Europe/Moscow",
      now: new Date("2026-10-19T09:00:00Z"),
    });
    expect(prompt).toContain("Описание проекта (README):\nГолосовой помощник для звонков.");
    expect(prompt).toContain("Локально: ветка main, незакоммиченных изменений: 3");
  });
});

describe("projects from this computer", () => {
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
    calls.getUserByTelegramId.mockResolvedValue(USER);
    calls.getUserById.mockResolvedValue(USER);
    calls.isClaudeRelayConfigured.mockReturnValue(true);
  });

  it("each folder becomes a project with its commits; work projects never get in", async () => {
    const existing = await createProjectFromApp({
      userId: OWNER,
      title: "Мой JARVIS",
      repo: "znamteam-max/JARVIS",
    });
    const results = await importProjects([
      {
        folder: "JARVIS",
        repo: "znamteam-max/JARVIS",
        git: true,
        branch: "main",
        dirty: 2,
        commits: [commit("a".repeat(40), "Projects tab"), commit("b".repeat(40), "Summary")],
        readme: "Личный ассистент",
      },
      {
        folder: "ZNAMBO-Calls",
        repo: null,
        git: true,
        branch: "main",
        dirty: 0,
        commits: [commit("c".repeat(40), "First call flow")],
        readme: null,
      },
      {
        folder: "ZNAMBO-Voice",
        repo: null,
        git: false,
        branch: null,
        dirty: null,
        commits: [],
        readme: "Голос",
      },
      {
        folder: "RNGN_STUDIO",
        repo: null,
        git: true,
        branch: "main",
        dirty: 0,
        commits: [commit("d".repeat(40), "secret work")],
        readme: null,
      },
      {
        folder: "Bolshe",
        repo: "RNGN-Autopost/Bolshe",
        git: true,
        branch: "main",
        dirty: 0,
        commits: [],
        readme: null,
      },
    ]);

    expect(results).toEqual([
      { title: "Мой JARVIS", created: false, added: 2 },
      { title: "ZNAMBO-Calls", created: true, added: 1 },
      { title: "ZNAMBO-Voice", created: true, added: 0 },
      { title: "RNGN_STUDIO", created: false, added: 0, skipped: "work" },
      { title: "Bolshe", created: false, added: 0, skipped: "work" },
    ]);
    const titles = (await listProjectsView(OWNER)).map((project) => project.title).sort();
    expect(titles).toEqual(["ZNAMBO-Calls", "ZNAMBO-Voice", "Мой JARVIS"]);

    const jarvis = await getProjectView(OWNER, existing.id);
    expect(jarvis.done.map((row) => [row.text, row.source])).toEqual([
      ["Projects tab", "github"],
      ["Summary", "github"],
    ]);
    expect((await getProject(OWNER, existing.id))?.metadata).toMatchObject({
      readme: "Личный ассистент",
      local: { git: true, branch: "main", dirty: 2 },
    });
    const callsProject = (await listProjectsView(OWNER)).find((p) => p.title === "ZNAMBO-Calls")!;
    expect((await getProjectView(OWNER, callsProject.id)).done[0]).toMatchObject({
      source: "git",
      url: null,
    });

    // Running it again adds nothing twice.
    const again = await importProjects([
      {
        folder: "JARVIS",
        repo: "znamteam-max/JARVIS",
        git: true,
        branch: "main",
        dirty: 0,
        commits: [commit("a".repeat(40), "Projects tab"), commit("e".repeat(40), "Voice")],
        readme: null,
      },
    ]);
    expect(again).toEqual([{ title: "Мой JARVIS", created: false, added: 1 }]);
  });

  it("JARVIS writes the summary by itself for a project with new lines, one per tick", async () => {
    await importProjects([
      {
        folder: "ZNAMBO-Calls",
        repo: null,
        git: true,
        branch: "main",
        dirty: 1,
        commits: [commit("c".repeat(40), "First call flow")],
        readme: null,
      },
    ]);
    calls.askClaudeRelay.mockResolvedValue({
      result: "Сейчас: первый сценарий звонка готов.\nДальше: тесты.",
      structured: null,
      model: "claude-opus-5-5",
    });
    const now = new Date();

    expect(await summarizeStaleProjects(now)).toEqual({ checked: 1, written: 1 });
    const [listed] = await listProjectsView(OWNER);
    expect(listed.summaryLine).toBe("первый сценарий звонка готов.");

    // Up to date now: nothing more to do.
    expect(await summarizeStaleProjects(new Date(now.getTime() + 60 * 60 * 1000))).toEqual({
      checked: 0,
      written: 0,
    });
  });

  it("leaves the owner's own summary and finished projects alone, and waits after a failure", async () => {
    const own = await createProjectFromApp({ userId: OWNER, title: "Своё" });
    await importProjects([
      {
        folder: "Своё",
        repo: null,
        git: true,
        branch: "main",
        dirty: 0,
        commits: [commit("1".repeat(40), "x")],
        readme: null,
      },
    ]);
    await updateProjectFromApp({ userId: OWNER, projectId: own.id, summary: "Моя сводка" });
    const done = await createProjectFromApp({ userId: OWNER, title: "Готово", status: "done" });
    await importProjects([
      {
        folder: "Готово",
        repo: null,
        git: true,
        branch: "main",
        dirty: 0,
        commits: [commit("2".repeat(40), "y")],
        readme: null,
      },
    ]);
    const failing = await createProjectFromApp({ userId: OWNER, title: "Сбой" });
    await importProjects([
      {
        folder: "Сбой",
        repo: null,
        git: true,
        branch: "main",
        dirty: 0,
        commits: [commit("3".repeat(40), "z")],
        readme: null,
      },
    ]);
    calls.askClaudeRelay.mockRejectedValue(new Error("relay down"));
    const now = new Date();

    expect(await summarizeStaleProjects(now)).toEqual({ checked: 1, written: 0 });
    expect(calls.askClaudeRelay).toHaveBeenCalledTimes(1);
    // The failed one waits; the other two are never picked.
    expect(await summarizeStaleProjects(new Date(now.getTime() + 60_000))).toEqual({
      checked: 0,
      written: 0,
    });
    expect((await getProject(OWNER, own.id))?.summary).toBe("Моя сводка");
    expect((await getProject(OWNER, done.id))?.summary).toBeNull();
    expect((await getProject(OWNER, failing.id))?.metadata).toHaveProperty("summaryAttemptAt");
  });

  it("JARVIS sees the projects that are not finished, with where each stands", async () => {
    const live = await createProjectFromApp({ userId: OWNER, title: "JARVIS" });
    await updateProjectFromApp({
      userId: OWNER,
      projectId: live.id,
      summary: "Сейчас: голос на главной.",
      status: "waiting",
      waitingFor: "деплоя",
    });
    await createProjectFromApp({ userId: OWNER, title: "Старое", status: "done" });

    const block = await projectsContextBlock(OWNER);
    expect(block).toContain("# Проекты владельца");
    expect(block).toContain("- JARVIS (ждёт, ждём: деплоя");
    expect(block).toContain("): голос на главной.; впереди шагов: 0");
    expect(block).not.toContain("Старое");
  });
});
