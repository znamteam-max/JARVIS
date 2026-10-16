import { DateTime } from "luxon";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  estimateFoodFromImage,
  estimateFoodFromText,
  type FoodEstimationResult,
} from "@/ai/foodEstimation";
import { writeAudit } from "@/db/queries/audit";
import {
  deleteFoodEntry,
  getFoodEntryById,
  insertFoodEntry,
  setFoodEntryEatenAt,
  toFoodEstimate,
  updateFoodEntryEstimate,
} from "@/db/queries/food";
import { sumFoodMacros } from "@/domain/foodEstimate";
import { scaleFoodItems } from "@/domain/miniapp";
import { logger } from "@/lib/logger";
import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import type { User } from "@/db/schema";
import { deleteFoodPhoto, saveFoodPhoto } from "@/services/foodPhotos";
import { buildMiniAppSummary } from "@/services/miniappSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const MAX_BACKDATE_DAYS = 7;

const textSchema = z.object({
  text: z.string().trim().min(2).max(500),
  eatenAtLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
});

const gramsSchema = z.object({
  id: z.string().uuid(),
  grams: z.array(z.number().min(0).max(3000).nullable()).max(30),
});

const amount = (max: number) => z.number().min(0).max(max);

// The full editor: title, time and every product's weight and КБЖУ (the browser's
// calculator keeps them consistent; the server re-adds the totals itself).
const fullEditSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  eatenAtLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        grams: amount(5000).nullable(),
        calories: amount(10000),
        proteinG: amount(1000),
        fatG: amount(1000),
        carbsG: amount(1000),
      }),
    )
    .min(1)
    .max(30),
});

const MAX_EDIT_BACKDATE_DAYS = 30;

// JSON = a meal described in words ("ate it and forgot the photo"); multipart = a photo.
export async function POST(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (request.headers.get("content-type")?.includes("application/json")) {
    return logFoodFromText(request, owner);
  }
  const form = await request.formData().catch(() => null);
  const photo = form?.get("photo");
  if (!(photo instanceof File) || photo.size === 0 || photo.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ ok: false, error: "photo_missing_or_too_large" }, { status: 400 });
  }
  const caption = String(form?.get("caption") ?? "").trim() || null;
  try {
    const bytes = Buffer.from(await photo.arrayBuffer());
    const result = await estimateFoodFromImage({
      bytes,
      mimeType: photo.type || "image/jpeg",
      caption,
    });
    await auditUsage(owner, result, "food_estimation_miniapp");
    if (!result.estimate.isFood) {
      return NextResponse.json({ ok: false, error: "not_food" }, { status: 422 });
    }
    const entry = await insertFoodEntry({
      userId: owner.id,
      sourceMessageId: null,
      telegramFileId: null,
      caption,
      eatenAt: new Date(),
      estimate: result.estimate,
      model: result.model,
    });
    if (entry) await saveFoodPhoto({ entryId: entry.id, bytes });
  } catch (error) {
    logger.warn("Mini App food estimation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "estimation_failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}

async function logFoodFromText(request: Request, owner: User) {
  const body = textSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const now = DateTime.utc();
  const eatenAt = body.data.eatenAtLocal
    ? DateTime.fromISO(body.data.eatenAtLocal, { zone: owner.timezone }).toUTC()
    : now;
  if (
    !eatenAt.isValid ||
    eatenAt > now.plus({ minutes: 5 }) ||
    eatenAt < now.minus({ days: MAX_BACKDATE_DAYS })
  ) {
    return NextResponse.json({ ok: false, error: "invalid_time" }, { status: 400 });
  }
  try {
    const result = await estimateFoodFromText({ text: body.data.text });
    await auditUsage(owner, result, "food_estimation_text_miniapp");
    if (!result.estimate.isFood) {
      return NextResponse.json({ ok: false, error: "not_food_text" }, { status: 422 });
    }
    await insertFoodEntry({
      userId: owner.id,
      sourceMessageId: null,
      telegramFileId: null,
      caption: body.data.text,
      eatenAt: eatenAt.toJSDate(),
      estimate: result.estimate,
      model: result.model,
    });
  } catch (error) {
    logger.warn("Mini App text food estimation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "estimation_failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}

async function saveFullEdit(raw: unknown, owner: User) {
  const body = fullEditSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const entry = await getFoodEntryById({ userId: owner.id, entryId: body.data.id });
  if (!entry) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  let eatenAt: Date | null = null;
  if (body.data.eatenAtLocal) {
    const local = DateTime.fromISO(body.data.eatenAtLocal, { zone: owner.timezone }).toUTC();
    const now = DateTime.utc();
    if (
      !local.isValid ||
      local > now.plus({ minutes: 5 }) ||
      local < now.minus({ days: MAX_EDIT_BACKDATE_DAYS })
    ) {
      return NextResponse.json({ ok: false, error: "invalid_time" }, { status: 400 });
    }
    // The form shows minutes only, so an untouched time must not drop the seconds.
    const minute = (ms: number) => Math.floor(ms / 60_000);
    if (minute(entry.eatenAt.getTime()) !== minute(local.toMillis())) eatenAt = local.toJSDate();
  }

  const items = body.data.items.map((item) => ({
    name: item.name,
    grams: item.grams === null ? null : Math.round(item.grams),
    calories: Math.round(item.calories),
    proteinG: Math.round(item.proteinG),
    fatG: Math.round(item.fatG),
    carbsG: Math.round(item.carbsG),
  }));
  const totals = sumFoodMacros(items);
  await updateFoodEntryEstimate({
    userId: owner.id,
    entryId: entry.id,
    estimate: { ...toFoodEstimate(entry), title: body.data.title, items, ...totals },
    correction: "изменено вручную в приложении",
    at: new Date(),
  });
  if (eatenAt) await setFoodEntryEatenAt({ userId: owner.id, entryId: entry.id, eatenAt });
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}

async function auditUsage(owner: User, result: FoodEstimationResult, capability: string) {
  await writeAudit({
    userId: owner.id,
    action: "assistant.openai_usage",
    entityType: "food_entry",
    details: {
      capability,
      model: result.model,
      succeeded: true,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
    },
  }).catch(() => undefined);
}

export async function PATCH(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const raw: unknown = await request.json().catch(() => null);
  if (raw && typeof raw === "object" && "items" in raw) return saveFullEdit(raw, owner);
  const body = gramsSchema.safeParse(raw);
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
  // ?what=photo removes only the picture; deleting the entry takes its picture along.
  if (new URL(request.url).searchParams.get("what") !== "photo") {
    await deleteFoodEntry({ userId: owner.id, entryId: id });
  }
  try {
    await deleteFoodPhoto({ userId: owner.id, entryId: id });
  } catch (error) {
    logger.warn("Food photo delete failed", {
      entryId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "photo_delete_failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}
