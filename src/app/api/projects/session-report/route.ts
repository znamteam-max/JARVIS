import { NextResponse } from "next/server";
import { z } from "zod";

import { getEnv } from "@/lib/env";
import { constantTimeEquals } from "@/lib/secrets";
import { receiveSessionReport } from "@/services/projectSessionReports";
import { normalizeRepo, ProjectError } from "@/services/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reportSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  repo: z.string().trim().max(300).nullable().optional(),
  folder: z.string().trim().min(1).max(200),
  branch: z.string().trim().max(200).nullable().optional(),
  userMessage: z.string().max(50_000).nullable().optional(),
  assistantMessage: z.string().trim().min(1).max(200_000),
});

function repoOrNull(raw: string | null | undefined) {
  try {
    return normalizeRepo(raw);
  } catch (error) {
    if (error instanceof ProjectError) return null;
    throw error;
  }
}

// The Claude Code Stop hook (ops/claude-code/jarvis-report.mjs) posts each finished turn
// here. The report is only stored; the scheduler tick turns it into log lines.
export async function POST(request: Request) {
  const secret = getEnv().PROJECT_REPORT_TOKEN;
  if (!secret) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  if (!constantTimeEquals(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = reportSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const stored = await receiveSessionReport({
    sessionId: body.data.sessionId,
    repo: repoOrNull(body.data.repo),
    folder: body.data.folder,
    branch: body.data.branch ?? null,
    userMessage: body.data.userMessage ?? null,
    assistantMessage: body.data.assistantMessage,
  });
  if (!stored) return NextResponse.json({ ok: false, error: "owner_unknown" }, { status: 503 });
  return NextResponse.json({ ok: true, ...stored }, { status: 202 });
}
