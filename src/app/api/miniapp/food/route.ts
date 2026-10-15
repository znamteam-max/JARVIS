import { NextResponse } from "next/server";
import { z } from "zod";

import { estimateFoodFromImage } from "@/ai/foodEstimation";
import { writeAudit } from "@/db/queries/audit";
import {
  deleteFoodEntry,
  getFoodEntryById,
  insertFoodEntry,
  toFoodEstimate,
  updateFoodEntryEstimate,
} from "@/db/queries/food";
import { scaleFoodItems } from "@/domain/miniapp";
import { logger } from "@/lib/logger";
import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import { buildMiniAppSummary } from "@/services/miniappSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const gramsSchema = z.object({
  id: z.string().uuid(),
  grams: z.array(z.number().min(0).max(3000).nullable()).max(30),
});

export async function POST(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const form = await request.formData().catch(() => null);
  const photo = form?.get("photo");
  if (!(photo instanceof File) || photo.size === 0 || photo.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ ok: false, error: "photo_missing_or_too_large" }, { status: 400 });
  }
  const caption = String(form?.get("caption") ?? "").trim() || null;
  try {
    const result = await estimateFoodFromImage({
      bytes: Buffer.from(await photo.arrayBuffer()),
      mimeType: photo.type || "image/jpeg",
      caption,
    });
    await writeAudit({
      userId: owner.id,
      action: "assistant.openai_usage",
      entityType: "food_entry",
      details: {
        capability: "food_estimation_miniapp",
        model: result.model,
        succeeded: true,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
      },
    }).catch(() => undefined);
    if (!result.estimate.isFood) {
      return NextResponse.json({ ok: false, error: "not_food" }, { status: 422 });
    }
    await insertFoodEntry({
      userId: owner.id,
      sourceMessageId: null,
      telegramFileId: null,
      caption,
      eatenAt: new Date(),
      estimate: result.estimate,
      model: result.model,
    });
  } catch (error) {
    logger.warn("Mini App food estimation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "estimation_failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}

export async function PATCH(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = gramsSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const entry = await getFoodEntryById({ userId: owner.id, entryId: body.data.id });
  if (!entry) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const current = toFoodEstimate(entry);
  const scaled = scaleFoodItems(current.items, body.data.grams);
  if (!scaled.items.length) {
    return NextResponse.json({ ok: false, error: "empty_entry" }, { status: 400 });
  }
  await updateFoodEntryEstimate({
    userId: owner.id,
    entryId: entry.id,
    estimate: { ...current, items: scaled.items, ...scaled.totals },
    correction: "граммы изменены в приложении",
    at: new Date(),
  });
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}

export async function DELETE(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  await deleteFoodEntry({ userId: owner.id, entryId: id });
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}
