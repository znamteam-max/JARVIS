import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { projectsDb } from "../ensureProjectsSchema";
import { projectEntries, projects, type ProjectEntry } from "../schema";

export async function listProjects(userId: string) {
  return (await projectsDb())
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.lastActivityAt));
}

// Every project linked to a GitHub repo and not finished: the commit sync's work list.
export async function listProjectsWithRepo() {
  return (await projectsDb())
    .select()
    .from(projects)
    .where(and(isNotNull(projects.repo), ne(projects.status, "done")))
    .orderBy(projects.lastActivityAt);
}

// A Claude Code report finds its project by repo (GitHub names ignore case), else by a
// title equal to the folder name.
export async function findProjectForReport(userId: string, repo: string | null, folder: string) {
  if (repo) {
    const [byRepo] = await (
      await projectsDb()
    )
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), sql`lower(${projects.repo}) = ${repo.toLowerCase()}`))
      .limit(1);
    if (byRepo) return byRepo;
  }
  const [byTitle] = await (
    await projectsDb()
  )
    .select()
    .from(projects)
    .where(
      and(eq(projects.userId, userId), sql`lower(${projects.title}) = ${folder.toLowerCase()}`),
    )
    .orderBy(desc(projects.lastActivityAt))
    .limit(1);
  return byTitle ?? null;
}

export async function getProject(userId: string, projectId: string) {
  const [row] = await (
    await projectsDb()
  )
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.id, projectId)))
    .limit(1);
  return row ?? null;
}

export async function createProject(params: {
  userId: string;
  title: string;
  status?: string;
  waitingFor?: string | null;
  summary?: string | null;
  repo?: string | null;
}) {
  const [row] = await (await projectsDb()).insert(projects).values(params).returning();
  return row;
}

export async function updateProject(
  userId: string,
  projectId: string,
  patch: {
    title?: string;
    status?: string;
    waitingFor?: string | null;
    summary?: string | null;
    repo?: string | null;
  },
  // metadata is merged into what is stored; touch = false keeps "updated" as it was
  // (a regenerated summary is not progress on the project).
  options: { metadata?: Record<string, unknown>; touch?: boolean } = {},
) {
  const now = new Date();
  const [row] = await (
    await projectsDb()
  )
    .update(projects)
    .set({
      ...patch,
      updatedAt: now,
      ...(options.touch === false ? {} : { lastActivityAt: now }),
      ...(options.metadata
        ? { metadata: sql`${projects.metadata} || ${JSON.stringify(options.metadata)}::jsonb` }
        : {}),
    })
    .where(and(eq(projects.userId, userId), eq(projects.id, projectId)))
    .returning();
  return row ?? null;
}

export async function deleteProject(userId: string, projectId: string) {
  const [row] = await (
    await projectsDb()
  )
    .delete(projects)
    .where(and(eq(projects.userId, userId), eq(projects.id, projectId)))
    .returning();
  return row ?? null;
}

export async function listProjectEntries(userId: string, projectId: string, limit = 300) {
  return (await projectsDb())
    .select()
    .from(projectEntries)
    .where(and(eq(projectEntries.userId, userId), eq(projectEntries.projectId, projectId)))
    .orderBy(desc(projectEntries.occurredAt))
    .limit(limit);
}

// The list screen needs, per project, how many todos are open and the latest thing done.
export async function listProjectSnapshots(userId: string, projectIds: string[]) {
  const openTodos = new Map<string, number>();
  const lastDone = new Map<string, { text: string; at: Date }>();
  if (projectIds.length === 0) return { openTodos, lastDone };
  const db = await projectsDb();
  const counts = await db
    .select({ projectId: projectEntries.projectId, open: sql<number>`count(*)::int` })
    .from(projectEntries)
    .where(
      and(
        eq(projectEntries.userId, userId),
        inArray(projectEntries.projectId, projectIds),
        eq(projectEntries.kind, "todo"),
        isNull(projectEntries.closedAt),
      ),
    )
    .groupBy(projectEntries.projectId);
  const doneAt = sql<Date>`coalesce(${projectEntries.closedAt}, ${projectEntries.occurredAt})`;
  const latest = await db
    .selectDistinctOn([projectEntries.projectId], {
      projectId: projectEntries.projectId,
      text: projectEntries.text,
      at: doneAt,
    })
    .from(projectEntries)
    .where(
      and(
        eq(projectEntries.userId, userId),
        inArray(projectEntries.projectId, projectIds),
        or(
          eq(projectEntries.kind, "done"),
          and(eq(projectEntries.kind, "todo"), isNotNull(projectEntries.closedAt)),
        ),
      ),
    )
    .orderBy(projectEntries.projectId, desc(doneAt));
  for (const row of counts) openTodos.set(row.projectId, Number(row.open));
  for (const row of latest) lastDone.set(row.projectId, { text: row.text, at: new Date(row.at) });
  return { openTodos, lastDone };
}

type NewProjectEntry = {
  userId: string;
  projectId: string;
  kind: string;
  text: string;
  source?: string;
  externalId?: string | null;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
};

// An entry with an externalId that is already stored (the same commit, the same session
// report) is skipped: returns null.
export async function insertProjectEntry(params: NewProjectEntry): Promise<ProjectEntry | null> {
  const [row] = await insertProjectEntries(params.userId, params.projectId, [params]);
  return row ?? null;
}

// Many lines of one project in one statement; returns only the ones actually stored.
export async function insertProjectEntries(
  userId: string,
  projectId: string,
  rows: Array<Omit<NewProjectEntry, "userId" | "projectId">>,
) {
  if (rows.length === 0) return [];
  const inserted = await (
    await projectsDb()
  )
    .insert(projectEntries)
    .values(rows.map((row) => ({ ...row, userId, projectId, metadata: row.metadata ?? {} })))
    .onConflictDoNothing()
    .returning();
  if (inserted.length) {
    const latest = Math.max(...inserted.map((row) => row.occurredAt.getTime()));
    await touchProject(userId, projectId, new Date(latest));
  }
  return inserted;
}

// One line kept up to date by its source (a Claude Code session's "done so far"):
// inserted once, then its text, date and metadata follow the latest report.
export async function upsertProjectEntry(params: {
  userId: string;
  projectId: string;
  kind: string;
  source: string;
  externalId: string;
  text: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}) {
  const metadata = params.metadata ?? {};
  const [row] = await (
    await projectsDb()
  )
    .insert(projectEntries)
    .values({ ...params, metadata })
    .onConflictDoUpdate({
      target: [projectEntries.projectId, projectEntries.source, projectEntries.externalId],
      targetWhere: sql`${projectEntries.externalId} is not null`,
      set: { text: params.text, occurredAt: params.occurredAt, metadata, updatedAt: new Date() },
    })
    .returning();
  await touchProject(params.userId, params.projectId, params.occurredAt);
  return row;
}

// The open todos one source keeps under a prefix ("session:<id>:next:") become exactly
// `items`: new ones are added, dropped open ones removed; ticked-off ones stay as they are.
export async function replaceOpenEntries(params: {
  userId: string;
  projectId: string;
  source: string;
  prefix: string;
  items: Array<{ externalId: string; text: string }>;
  occurredAt: Date;
}) {
  const keep = params.items.map((item) => item.externalId);
  await (await projectsDb())
    .delete(projectEntries)
    .where(
      and(
        eq(projectEntries.userId, params.userId),
        eq(projectEntries.projectId, params.projectId),
        eq(projectEntries.source, params.source),
        eq(projectEntries.kind, "todo"),
        isNull(projectEntries.closedAt),
        like(projectEntries.externalId, `${params.prefix}%`),
        keep.length ? notInArray(projectEntries.externalId, keep) : undefined,
      ),
    );
  return insertProjectEntries(
    params.userId,
    params.projectId,
    params.items.map((item) => ({
      kind: "todo",
      source: params.source,
      externalId: item.externalId,
      text: item.text,
      occurredAt: params.occurredAt,
    })),
  );
}

export async function updateProjectEntry(
  userId: string,
  entryId: string,
  patch: { text?: string; closedAt?: Date | null },
  onlyKind?: string,
) {
  const [row] = await (
    await projectsDb()
  )
    .update(projectEntries)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(projectEntries.userId, userId),
        eq(projectEntries.id, entryId),
        onlyKind ? eq(projectEntries.kind, onlyKind) : undefined,
      ),
    )
    .returning();
  if (row) await touchProject(userId, row.projectId);
  return row ?? null;
}

export async function deleteProjectEntry(userId: string, entryId: string) {
  const [row] = await (
    await projectsDb()
  )
    .delete(projectEntries)
    .where(and(eq(projectEntries.userId, userId), eq(projectEntries.id, entryId)))
    .returning();
  return row ?? null;
}

// "Updated" follows the latest real step: importing old commits does not make a project
// look fresh.
async function touchProject(userId: string, projectId: string, at = new Date()) {
  await (
    await projectsDb()
  )
    .update(projects)
    .set({
      lastActivityAt: sql`greatest(${projects.lastActivityAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(and(eq(projects.userId, userId), eq(projects.id, projectId)));
}
