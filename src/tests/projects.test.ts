import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createProjectsTestDb } from "./helpers/projectsTestDb";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import {
  insertProjectEntry,
  listProjectSnapshots,
  updateProjectEntry,
} from "@/db/queries/projects";
import {
  addProjectEntryFromApp,
  buildProjectDetail,
  buildProjectList,
  createProjectFromApp,
  editProjectEntryFromApp,
  getProjectView,
  listProjectsView,
  normalizeRepo,
  ProjectError,
  removeProject,
  updateProjectFromApp,
} from "@/services/projects";
import type { Project, ProjectEntry } from "@/db/schema";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function project(overrides: Partial<Project>): Project {
  return {
    id: "p1",
    userId: OWNER,
    title: "JARVIS",
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

describe("the projects list", () => {
  it("puts active projects first, then waiting, paused and done, freshest first", () => {
    const list = buildProjectList(
      [
        project({ id: "done", status: "done", lastActivityAt: new Date("2026-10-19T00:00:00Z") }),
        project({ id: "old", status: "active", lastActivityAt: new Date("2026-10-01T00:00:00Z") }),
        project({ id: "wait", status: "waiting", waitingFor: "ответа заказчика" }),
        project({ id: "new", status: "active", lastActivityAt: new Date("2026-10-18T00:00:00Z") }),
        project({ id: "pause", status: "paused" }),
      ],
      { openTodos: new Map([["new", 3]]), lastDone: new Map() },
    );
    expect(list.map((row) => row.id)).toEqual(["new", "old", "wait", "pause", "done"]);
    expect(list[0].openTodos).toBe(3);
    expect(list[1].openTodos).toBe(0);
    expect(list[2].waitingFor).toBe("ответа заказчика");
  });

  it("an unknown stored status is shown as active instead of breaking the screen", () => {
    const [row] = buildProjectList([project({ status: "archived" })], {
      openTodos: new Map(),
      lastDone: new Map(),
    });
    expect(row.status).toBe("active");
  });
});

describe("one project's summary", () => {
  it("splits the log into ahead (in planned order), done (newest first) and notes", () => {
    const view = buildProjectDetail(project({}), [
      entry({ id: "todo-later", kind: "todo", occurredAt: new Date("2026-10-15T00:00:00Z") }),
      entry({ id: "todo-first", kind: "todo", occurredAt: new Date("2026-10-10T00:00:00Z") }),
      entry({ id: "done-old", kind: "done", occurredAt: new Date("2026-10-11T00:00:00Z") }),
      entry({
        id: "todo-closed",
        kind: "todo",
        occurredAt: new Date("2026-10-09T00:00:00Z"),
        closedAt: new Date("2026-10-17T00:00:00Z"),
      }),
      entry({ id: "note", kind: "note" }),
    ]);
    expect(view.ahead.map((row) => row.id)).toEqual(["todo-first", "todo-later"]);
    // A todo done on the 17th counts from the day it was done, not when it was planned.
    expect(view.done.map((row) => row.id)).toEqual(["todo-closed", "done-old"]);
    expect(view.done[0]).toMatchObject({ closed: true, at: "2026-10-17T00:00:00.000Z" });
    expect(view.notes.map((row) => row.id)).toEqual(["note"]);
  });
});

describe("the GitHub repo field", () => {
  it.each([
    ["znamteam-max/JARVIS", "znamteam-max/JARVIS"],
    ["https://github.com/znamteam-max/JARVIS.git", "znamteam-max/JARVIS"],
    [
      "github.com/RNGN-Autopost/Bolshe-Autopost-Frontend/",
      "RNGN-Autopost/Bolshe-Autopost-Frontend",
    ],
    ["  ", null],
    [null, null],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeRepo(raw)).toBe(expected);
  });

  it("anything that is not owner/name is refused", () => {
    expect(() => normalizeRepo("просто текст")).toThrow(ProjectError);
    expect(() => normalizeRepo("https://gitlab.com/a/b")).toThrow(ProjectError);
  });
});

describe("projects in a real database", () => {
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
  });

  it("a project collects done lines and todos, and a todo ticked off moves to done", async () => {
    const created = await createProjectFromApp({ userId: OWNER, title: "JARVIS" });
    await addProjectEntryFromApp({
      userId: OWNER,
      projectId: created.id,
      kind: "done",
      text: "Сделал схему",
    });
    const withTodo = await addProjectEntryFromApp({
      userId: OWNER,
      projectId: created.id,
      kind: "todo",
      text: "Вкладка в Mini App",
    });
    expect(withTodo.ahead.map((row) => row.text)).toEqual(["Вкладка в Mini App"]);

    const ticked = await editProjectEntryFromApp({
      userId: OWNER,
      entryId: withTodo.ahead[0].id,
      done: true,
    });
    expect(ticked.ahead).toEqual([]);
    expect(ticked.done.map((row) => row.text)).toEqual(["Вкладка в Mini App", "Сделал схему"]);

    const [listed] = await listProjectsView(OWNER);
    expect(listed).toMatchObject({ title: "JARVIS", openTodos: 0 });
    expect(listed.lastDone?.text).toBe("Вкладка в Mini App");
  });

  it("the list counts open todos per project", async () => {
    const a = await createProjectFromApp({ userId: OWNER, title: "A" });
    const b = await createProjectFromApp({ userId: OWNER, title: "B" });
    for (const text of ["1", "2"]) {
      await insertProjectEntry({ userId: OWNER, projectId: a.id, kind: "todo", text });
    }
    await insertProjectEntry({ userId: OWNER, projectId: b.id, kind: "note", text: "n" });
    const snapshots = await listProjectSnapshots(OWNER, [a.id, b.id]);
    expect(snapshots.openTodos.get(a.id)).toBe(2);
    expect(snapshots.openTodos.has(b.id)).toBe(false);
    expect(snapshots.lastDone.size).toBe(0);
  });

  it("the same commit or session report never lands twice", async () => {
    const created = await createProjectFromApp({ userId: OWNER, title: "JARVIS" });
    const report = {
      userId: OWNER,
      projectId: created.id,
      kind: "done",
      text: "Commit",
      source: "github",
      externalId: "b67face",
    };
    expect(await insertProjectEntry(report)).not.toBeNull();
    expect(await insertProjectEntry(report)).toBeNull();
    expect((await getProjectView(OWNER, created.id)).done).toHaveLength(1);
  });

  it("only a todo can be ticked off — a note stays a note", async () => {
    const created = await createProjectFromApp({ userId: OWNER, title: "JARVIS" });
    const note = await insertProjectEntry({
      userId: OWNER,
      projectId: created.id,
      kind: "note",
      text: "Контекст",
    });
    await expect(
      editProjectEntryFromApp({ userId: OWNER, entryId: note!.id, done: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await updateProjectEntry(OWNER, note!.id, { text: "Новый контекст" })).toMatchObject({
      text: "Новый контекст",
      closedAt: null,
    });
  });

  it("leaving 'waiting' forgets what it was waiting for", async () => {
    const created = await createProjectFromApp({
      userId: OWNER,
      title: "Сайт",
      status: "waiting",
      waitingFor: "ответа заказчика",
    });
    const resumed = await updateProjectFromApp({
      userId: OWNER,
      projectId: created.id,
      status: "active",
    });
    expect(resumed).toMatchObject({ status: "active", waitingFor: null });
  });

  it("one repo belongs to one project", async () => {
    await createProjectFromApp({ userId: OWNER, title: "JARVIS", repo: "znamteam-max/JARVIS" });
    await expect(
      createProjectFromApp({
        userId: OWNER,
        title: "Копия",
        repo: "https://github.com/znamteam-max/JARVIS",
      }),
    ).rejects.toMatchObject({ code: "repo_taken" });
  });

  it("another user sees nothing and changes nothing", async () => {
    const created = await createProjectFromApp({ userId: OWNER, title: "JARVIS" });
    expect(await listProjectsView(OTHER)).toEqual([]);
    await expect(getProjectView(OTHER, created.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      addProjectEntryFromApp({ userId: OTHER, projectId: created.id, kind: "done", text: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(removeProject(OTHER, created.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await listProjectsView(OWNER)).toHaveLength(1);
  });

  it("deleting a project takes its whole log with it", async () => {
    const created = await createProjectFromApp({ userId: OWNER, title: "JARVIS" });
    await insertProjectEntry({ userId: OWNER, projectId: created.id, kind: "done", text: "x" });
    await removeProject(OWNER, created.id);
    const left = await pg.query<{ count: number }>(
      "select count(*)::int as count from assistant.project_entries",
    );
    expect(left.rows[0].count).toBe(0);
  });
});
