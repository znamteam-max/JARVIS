import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import {
  addProjectEntryFromApp,
  createProjectFromApp,
  editProjectEntryFromApp,
  ENTRY_KINDS,
  getProjectView,
  listProjectsView,
  PROJECT_STATUSES,
  ProjectError,
  removeProject,
  removeProjectEntry,
  updateProjectFromApp,
} from "@/services/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const status = z.enum(PROJECT_STATUSES);
const shortText = z.string().trim().max(300);
const longText = z.string().trim().max(4000);

const createSchema = z.object({
  action: z.literal("create"),
  title: z.string().trim().min(1).max(200),
  status: status.optional(),
  waitingFor: shortText.nullable().optional(),
  summary: longText.nullable().optional(),
  repo: shortText.nullable().optional(),
});

const entrySchema = z.object({
  action: z.literal("entry"),
  projectId: z.string().uuid(),
  kind: z.enum(ENTRY_KINDS),
  text: z.string().trim().min(1).max(2000),
});

const projectPatchSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  status: status.optional(),
  waitingFor: shortText.nullable().optional(),
  summary: longText.nullable().optional(),
  repo: shortText.nullable().optional(),
});

const entryPatchSchema = z.object({
  entryId: z.string().uuid(),
  text: z.string().trim().min(1).max(2000).optional(),
  done: z.boolean().optional(),
});

function failure(error: unknown) {
  if (error instanceof ProjectError) {
    return NextResponse.json(
      { ok: false, error: error.code },
      { status: error.code === "not_found" ? 404 : 400 },
    );
  }
  throw error;
}

const invalid = () => NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
const unauthorized = () => NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

// ?id= → one project with what is done and what is ahead; otherwise the whole list.
export async function GET(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return unauthorized();
  const id = new URL(request.url).searchParams.get("id");
  if (id === null) {
    return NextResponse.json({ ok: true, projects: await listProjectsView(owner.id) });
  }
  if (!z.string().uuid().safeParse(id).success) return invalid();
  try {
    return NextResponse.json({ ok: true, project: await getProjectView(owner.id, id) });
  } catch (error) {
    return failure(error);
  }
}

// {action: "create"} a new project; {action: "entry"} adds a done / todo / note line.
export async function POST(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return unauthorized();
  const raw: unknown = await request.json().catch(() => null);
  try {
    const create = createSchema.safeParse(raw);
    if (create.success) {
      const { title, status, waitingFor, summary, repo } = create.data;
      const project = await createProjectFromApp({
        userId: owner.id,
        title,
        status,
        waitingFor,
        summary,
        repo,
      });
      return NextResponse.json({
        ok: true,
        message: `Добавил проект «${project.title}».`,
        project,
      });
    }
    const entry = entrySchema.safeParse(raw);
    if (entry.success) {
      const { projectId, kind, text } = entry.data;
      return NextResponse.json({
        ok: true,
        project: await addProjectEntryFromApp({ userId: owner.id, projectId, kind, text }),
      });
    }
  } catch (error) {
    return failure(error);
  }
  return invalid();
}

// {id, ...} edits the project; {entryId, ...} edits a line or ticks a todo off.
export async function PATCH(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return unauthorized();
  const raw: unknown = await request.json().catch(() => null);
  try {
    const entry = entryPatchSchema.safeParse(raw);
    if (entry.success) {
      return NextResponse.json({
        ok: true,
        project: await editProjectEntryFromApp({ userId: owner.id, ...entry.data }),
      });
    }
    const project = projectPatchSchema.safeParse(raw);
    if (project.success) {
      const { id, ...fields } = project.data;
      return NextResponse.json({
        ok: true,
        project: await updateProjectFromApp({ userId: owner.id, projectId: id, ...fields }),
      });
    }
  } catch (error) {
    return failure(error);
  }
  return invalid();
}

// ?entryId= removes one line; ?id= removes the project with its whole log.
export async function DELETE(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return unauthorized();
  const params = new URL(request.url).searchParams;
  const entryId = params.get("entryId");
  const id = params.get("id");
  const uuid = z.string().uuid();
  try {
    if (entryId !== null) {
      if (!uuid.safeParse(entryId).success) return invalid();
      return NextResponse.json({ ok: true, project: await removeProjectEntry(owner.id, entryId) });
    }
    if (id !== null) {
      if (!uuid.safeParse(id).success) return invalid();
      const deleted = await removeProject(owner.id, id);
      return NextResponse.json({
        ok: true,
        message: `Удалил проект «${deleted.title}».`,
        projects: await listProjectsView(owner.id),
      });
    }
  } catch (error) {
    return failure(error);
  }
  return invalid();
}
