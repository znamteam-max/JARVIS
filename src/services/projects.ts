import {
  createProject,
  deleteProject,
  deleteProjectEntry,
  getProject,
  insertProjectEntry,
  listProjectEntries,
  listProjects,
  listProjectSnapshots,
  updateProject,
  updateProjectEntry,
} from "@/db/queries/projects";
import type { Project, ProjectEntry } from "@/db/schema";
import { chatModelLabel } from "@/domain/chatModelLabel";

export const PROJECT_STATUSES = ["active", "waiting", "paused", "done"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ENTRY_KINDS = ["done", "todo", "note"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export type ProjectListView = {
  id: string;
  title: string;
  status: ProjectStatus;
  waitingFor: string | null;
  repo: string | null;
  lastActivityAt: string;
  openTodos: number;
  lastDone: { text: string; at: string } | null;
};

export type ProjectEntryView = {
  id: string;
  kind: EntryKind;
  text: string;
  source: string;
  // When it was added; for a closed todo, when it was done.
  at: string;
  closed: boolean;
};

export type ProjectDetailView = {
  id: string;
  title: string;
  status: ProjectStatus;
  waitingFor: string | null;
  summary: string | null;
  // Who wrote the summary: the owner or JARVIS (with the model), and when.
  summaryBy: "ai" | "manual" | null;
  summaryModel: string | null;
  summaryAt: string | null;
  // Entries were added or changed after the summary was written.
  summaryStale: boolean;
  repo: string | null;
  lastActivityAt: string;
  // Open todos in the order they were planned.
  ahead: ProjectEntryView[];
  // Done entries and closed todos, newest first.
  done: ProjectEntryView[];
  notes: ProjectEntryView[];
};

export class ProjectError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "repo_taken"
      | "invalid_repo"
      | "nothing_to_summarize"
      | "summary_failed",
  ) {
    super(code);
  }
}

function asStatus(value: string): ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(value)
    ? (value as ProjectStatus)
    : "active";
}

function asKind(value: string): EntryKind {
  return (ENTRY_KINDS as readonly string[]).includes(value) ? (value as EntryKind) : "note";
}

// "https://github.com/owner/name.git", "github.com/owner/name" or "owner/name" → "owner/name".
export function normalizeRepo(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const match =
    /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value);
  if (!match) throw new ProjectError("invalid_repo");
  return `${match[1]}/${match[2]}`;
}

// Active first, then waiting, paused and done; inside a group the freshest on top.
export function buildProjectList(
  rows: Project[],
  snapshots: {
    openTodos: Map<string, number>;
    lastDone: Map<string, { text: string; at: Date }>;
  },
): ProjectListView[] {
  return rows
    .map((row) => {
      const lastDone = snapshots.lastDone.get(row.id);
      return {
        id: row.id,
        title: row.title,
        status: asStatus(row.status),
        waitingFor: row.waitingFor,
        repo: row.repo,
        lastActivityAt: row.lastActivityAt.toISOString(),
        openTodos: snapshots.openTodos.get(row.id) ?? 0,
        lastDone: lastDone ? { text: lastDone.text, at: lastDone.at.toISOString() } : null,
      };
    })
    .sort(
      (a, b) =>
        PROJECT_STATUSES.indexOf(a.status) - PROJECT_STATUSES.indexOf(b.status) ||
        b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
}

function entryView(entry: ProjectEntry): ProjectEntryView {
  return {
    id: entry.id,
    kind: asKind(entry.kind),
    text: entry.text,
    source: entry.source,
    at: (entry.closedAt ?? entry.occurredAt).toISOString(),
    closed: entry.closedAt !== null,
  };
}

function summaryProvenance(project: Project, entries: ProjectEntry[]) {
  const meta = project.metadata ?? {};
  const at = typeof meta.summaryAt === "string" ? meta.summaryAt : null;
  const by: "ai" | "manual" | null =
    meta.summarySource === "ai" || meta.summarySource === "manual" ? meta.summarySource : null;
  const changedAfter = at
    ? entries.some((entry) => entry.updatedAt.getTime() > new Date(at).getTime())
    : false;
  return {
    summaryBy: project.summary ? by : null,
    summaryModel:
      project.summary && by === "ai"
        ? chatModelLabel({ model: meta.summaryModel, fallback: meta.summaryFallback })
        : null,
    summaryAt: project.summary ? at : null,
    summaryStale: Boolean(project.summary) && changedAfter,
  };
}

export function buildProjectDetail(project: Project, entries: ProjectEntry[]): ProjectDetailView {
  const views = entries.map(entryView);
  const newestFirst = (a: ProjectEntryView, b: ProjectEntryView) => b.at.localeCompare(a.at);
  return {
    id: project.id,
    title: project.title,
    status: asStatus(project.status),
    waitingFor: project.waitingFor,
    summary: project.summary,
    ...summaryProvenance(project, entries),
    repo: project.repo,
    lastActivityAt: project.lastActivityAt.toISOString(),
    ahead: views
      .filter((entry) => entry.kind === "todo" && !entry.closed)
      .sort((a, b) => a.at.localeCompare(b.at)),
    done: views
      .filter((entry) => entry.kind === "done" || (entry.kind === "todo" && entry.closed))
      .sort(newestFirst),
    notes: views.filter((entry) => entry.kind === "note").sort(newestFirst),
  };
}

function isUniqueViolation(error: unknown) {
  const code = (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value
      ? (value as { code: unknown }).code
      : null;
  return (
    code(error) === "23505" ||
    (error instanceof Error && code((error as { cause?: unknown }).cause) === "23505")
  );
}

async function guardRepo<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProjectError("repo_taken");
    throw error;
  }
}

export async function listProjectsView(userId: string) {
  const rows = await listProjects(userId);
  const snapshots = await listProjectSnapshots(
    userId,
    rows.map((row) => row.id),
  );
  return buildProjectList(rows, snapshots);
}

export async function getProjectView(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  if (!project) throw new ProjectError("not_found");
  return buildProjectDetail(project, await listProjectEntries(userId, projectId));
}

export async function createProjectFromApp(params: {
  userId: string;
  title: string;
  status?: ProjectStatus;
  waitingFor?: string | null;
  summary?: string | null;
  repo?: string | null;
}) {
  const repo = normalizeRepo(params.repo);
  const project = await guardRepo(() =>
    createProject({
      userId: params.userId,
      title: params.title,
      status: params.status ?? "active",
      waitingFor: params.waitingFor || null,
      summary: params.summary || null,
      repo,
    }),
  );
  return buildProjectDetail(project, []);
}

export async function updateProjectFromApp(params: {
  userId: string;
  projectId: string;
  title?: string;
  status?: ProjectStatus;
  waitingFor?: string | null;
  summary?: string | null;
  repo?: string | null;
}) {
  const { userId, projectId, ...fields } = params;
  const patch: Parameters<typeof updateProject>[2] = {};
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.waitingFor !== undefined) patch.waitingFor = fields.waitingFor || null;
  if (fields.summary !== undefined) patch.summary = fields.summary || null;
  if (fields.repo !== undefined) patch.repo = normalizeRepo(fields.repo);
  // Leaving "waiting" forgets what it was waiting for.
  if (fields.status && fields.status !== "waiting" && fields.waitingFor === undefined) {
    patch.waitingFor = null;
  }
  // A summary typed by hand is the owner's: JARVIS keeps its facts when it rewrites it.
  const metadata =
    fields.summary !== undefined
      ? { summarySource: "manual", summaryAt: new Date().toISOString(), summaryModel: null }
      : undefined;
  const updated = await guardRepo(() => updateProject(userId, projectId, patch, { metadata }));
  if (!updated) throw new ProjectError("not_found");
  return getProjectView(userId, projectId);
}

export async function removeProject(userId: string, projectId: string) {
  const deleted = await deleteProject(userId, projectId);
  if (!deleted) throw new ProjectError("not_found");
  return deleted;
}

export async function addProjectEntryFromApp(params: {
  userId: string;
  projectId: string;
  kind: EntryKind;
  text: string;
}) {
  if (!(await getProject(params.userId, params.projectId))) throw new ProjectError("not_found");
  await insertProjectEntry({ ...params, source: "manual" });
  return getProjectView(params.userId, params.projectId);
}

// A todo ticked off moves to "done"; unticked, it is ahead again.
export async function editProjectEntryFromApp(params: {
  userId: string;
  entryId: string;
  text?: string;
  done?: boolean;
}) {
  const patch: { text?: string; closedAt?: Date | null } = {};
  if (params.text !== undefined) patch.text = params.text;
  if (params.done !== undefined) patch.closedAt = params.done ? new Date() : null;
  // Only a todo can be ticked off.
  const updated = await updateProjectEntry(
    params.userId,
    params.entryId,
    patch,
    params.done !== undefined ? "todo" : undefined,
  );
  if (!updated) throw new ProjectError("not_found");
  return getProjectView(params.userId, updated.projectId);
}

export async function removeProjectEntry(userId: string, entryId: string) {
  const deleted = await deleteProjectEntry(userId, entryId);
  if (!deleted) throw new ProjectError("not_found");
  return getProjectView(userId, deleted.projectId);
}
