import { NextResponse } from "next/server";
import { z } from "zod";

import { getEnv } from "@/lib/env";
import { constantTimeEquals } from "@/lib/secrets";
import { importProjects } from "@/services/projectImport";
import { normalizeRepo, ProjectError } from "@/services/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const commitSchema = z.object({
  sha: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,64}$/i),
  subject: z.string().max(2000),
  date: z.string().max(64),
});

const importSchema = z.object({
  projects: z
    .array(
      z.object({
        folder: z.string().trim().min(1).max(200),
        repo: z.string().trim().max(300).nullable().optional(),
        git: z.boolean(),
        branch: z.string().trim().max(200).nullable().optional(),
        dirty: z.number().int().min(0).max(1_000_000).nullable().optional(),
        commits: z.array(commitSchema).max(100),
        readme: z.string().max(20_000).nullable().optional(),
      }),
    )
    .max(100),
});

function repoOrNull(raw: string | null | undefined) {
  try {
    return normalizeRepo(raw);
  } catch (error) {
    if (error instanceof ProjectError) return null;
    throw error;
  }
}

// ops/claude-code/import-projects.mjs posts the owner's project folders here (bearer
// PROJECT_REPORT_TOKEN, the same key as the session reports).
export async function POST(request: Request) {
  const secret = getEnv().PROJECT_REPORT_TOKEN;
  if (!secret) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  if (!constantTimeEquals(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = importSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const results = await importProjects(
    body.data.projects.map((project) => ({
      folder: project.folder,
      repo: repoOrNull(project.repo),
      git: project.git,
      branch: project.branch ?? null,
      dirty: project.dirty ?? null,
      commits: project.commits,
      readme: project.readme ?? null,
    })),
  );
  if (!results) return NextResponse.json({ ok: false, error: "owner_unknown" }, { status: 503 });
  return NextResponse.json({ ok: true, projects: results });
}
