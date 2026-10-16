import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteManualFitnessActivity } from "@/db/queries/fitness";
import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import { AppCreateError, logManualWorkout } from "@/services/miniappCreate";
import { buildMiniAppSummary } from "@/services/miniappSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const workoutSchema = z.object({
  sportType: z.enum([
    "Run",
    "Ride",
    "VirtualRide",
    "WeightTraining",
    "Walk",
    "Swim",
    "Yoga",
    "Workout",
  ]),
  startLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  durationMinutes: z.number().min(1).max(600),
  calories: z.number().min(0).max(5000).nullable(),
  distanceKm: z.number().min(0).max(500).nullable(),
});

// "Добавить тренировку": a session the watch did not record.
export async function POST(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = workoutSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  try {
    const logged = await logManualWorkout({ user: owner, ...body.data });
    const kcal = `${logged.estimated ? "≈ " : ""}${logged.calories} ккал`;
    return NextResponse.json({
      ok: true,
      message: `Записал: ${logged.label}, ${body.data.durationMinutes} мин, ${kcal}.`,
      summary: await buildMiniAppSummary(owner),
    });
  } catch (error) {
    if (error instanceof AppCreateError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 400 });
    }
    throw error;
  }
}

// Only hand-added workouts can be removed; watch data stays as Garmin sent it.
export async function DELETE(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const deleted = await deleteManualFitnessActivity({ userId: owner.id, id });
  if (!deleted) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({
    ok: true,
    message: "Удалил тренировку.",
    summary: await buildMiniAppSummary(owner),
  });
}
