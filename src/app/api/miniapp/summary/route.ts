import { NextResponse } from "next/server";
import { z } from "zod";

import { saveNutritionGoals } from "@/db/queries/food";
import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import { buildMiniAppSummary } from "@/services/miniappSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const goalsSchema = z.object({
  calories: z.number().int().min(1000).max(6000),
  proteinG: z.number().int().min(0).max(500),
  fatG: z.number().int().min(0).max(300),
  carbsG: z.number().int().min(0).max(800),
  workoutPercent: z.union([z.literal(0), z.literal(50), z.literal(100)]),
});

export async function GET(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}

export async function PUT(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const goals = goalsSchema.safeParse(await request.json().catch(() => null));
  if (!goals.success) {
    return NextResponse.json({ ok: false, error: "invalid_goals" }, { status: 400 });
  }
  await saveNutritionGoals(owner.id, goals.data);
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}
