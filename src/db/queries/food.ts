import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { getDb } from "../client";
import { foodEntries, nutritionGoals } from "../schema";
import type { FoodEstimate } from "@/domain/foodEstimate";
import { DEFAULT_NUTRITION_GOALS, type NutritionGoals } from "@/domain/miniapp";

export async function insertFoodEntry(params: {
  userId: string;
  sourceMessageId: string | null;
  telegramFileId: string | null;
  caption: string | null;
  eatenAt: Date;
  estimate: FoodEstimate;
  model: string;
}) {
  const [row] = await getDb()
    .insert(foodEntries)
    .values({
      userId: params.userId,
      sourceMessageId: params.sourceMessageId,
      telegramFileId: params.telegramFileId,
      caption: params.caption,
      title: params.estimate.title,
      eatenAt: params.eatenAt,
      calories: params.estimate.calories,
      proteinG: params.estimate.proteinG,
      fatG: params.estimate.fatG,
      carbsG: params.estimate.carbsG,
      items: params.estimate.items,
      confidence: params.estimate.confidence,
      model: params.model,
      metadata: params.estimate.note ? { note: params.estimate.note } : {},
    })
    .returning();
  return row ?? null;
}

export async function listFoodEntriesForDay(params: {
  userId: string;
  timezone: string;
  day: Date;
}) {
  const local = DateTime.fromJSDate(params.day, { zone: "utc" }).setZone(params.timezone);
  const start = local.startOf("day").toUTC().toJSDate();
  const end = local.startOf("day").plus({ days: 1 }).toUTC().toJSDate();
  return getDb()
    .select()
    .from(foodEntries)
    .where(
      and(
        eq(foodEntries.userId, params.userId),
        eq(foodEntries.status, "active"),
        gte(foodEntries.eatenAt, start),
        lt(foodEntries.eatenAt, end),
      ),
    )
    .orderBy(asc(foodEntries.eatenAt));
}

export async function deleteFoodEntry(params: { userId: string; entryId: string }) {
  const [row] = await getDb()
    .update(foodEntries)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(
      and(
        eq(foodEntries.id, params.entryId),
        eq(foodEntries.userId, params.userId),
        eq(foodEntries.status, "active"),
      ),
    )
    .returning();
  return row ?? null;
}

export function toFoodEstimate(row: typeof foodEntries.$inferSelect): FoodEstimate {
  return {
    isFood: true,
    title: row.title,
    items: row.items as unknown as FoodEstimate["items"],
    calories: row.calories,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbsG: row.carbsG,
    confidence: row.confidence as FoodEstimate["confidence"],
    note: typeof row.metadata?.note === "string" ? row.metadata.note : null,
  };
}

export async function updateFoodEntryEstimate(params: {
  userId: string;
  entryId: string;
  estimate: FoodEstimate;
  correction: string;
  at: Date;
}) {
  const record = JSON.stringify([{ text: params.correction, at: params.at.toISOString() }]);
  const [row] = await getDb()
    .update(foodEntries)
    .set({
      title: params.estimate.title,
      calories: params.estimate.calories,
      proteinG: params.estimate.proteinG,
      fatG: params.estimate.fatG,
      carbsG: params.estimate.carbsG,
      items: params.estimate.items,
      confidence: params.estimate.confidence,
      metadata: sql`jsonb_set(
        ${foodEntries.metadata} - 'correctionRequestedAt' || ${JSON.stringify({ note: params.estimate.note })}::jsonb,
        '{corrections}',
        coalesce(${foodEntries.metadata}->'corrections', '[]'::jsonb) || ${record}::jsonb
      )`,
      updatedAt: params.at,
    })
    .where(and(eq(foodEntries.id, params.entryId), eq(foodEntries.userId, params.userId)))
    .returning();
  return row ?? null;
}

export async function setFoodEntryReplyMessage(entryId: string, messageId: number) {
  await getDb()
    .update(foodEntries)
    .set({
      metadata: sql`${foodEntries.metadata} || ${JSON.stringify({ replyMessageId: String(messageId) })}::jsonb`,
    })
    .where(eq(foodEntries.id, entryId));
}

export async function requestFoodCorrection(params: { userId: string; entryId: string; at: Date }) {
  const [row] = await getDb()
    .update(foodEntries)
    .set({
      metadata: sql`${foodEntries.metadata} || ${JSON.stringify({ correctionRequestedAt: params.at.toISOString() })}::jsonb`,
    })
    .where(
      and(
        eq(foodEntries.id, params.entryId),
        eq(foodEntries.userId, params.userId),
        eq(foodEntries.status, "active"),
      ),
    )
    .returning();
  return row ?? null;
}

// A text is a correction when it replies to a food card or follows the "✏️ Исправить" button.
export async function findFoodEntryForCorrection(params: {
  userId: string;
  replyToMessageId: number | null;
  requestedSince: Date;
}) {
  const target = params.replyToMessageId
    ? sql`${foodEntries.metadata}->>'replyMessageId' = ${String(params.replyToMessageId)}`
    : sql`(${foodEntries.metadata}->>'correctionRequestedAt')::timestamptz >= ${params.requestedSince.toISOString()}::timestamptz`;
  const [row] = await getDb()
    .select()
    .from(foodEntries)
    .where(and(eq(foodEntries.userId, params.userId), eq(foodEntries.status, "active"), target))
    .orderBy(desc(foodEntries.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function getNutritionGoals(userId: string): Promise<NutritionGoals> {
  const [row] = await getDb()
    .select()
    .from(nutritionGoals)
    .where(eq(nutritionGoals.userId, userId))
    .limit(1);
  if (!row) return DEFAULT_NUTRITION_GOALS;
  return {
    calories: row.calories,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbsG: row.carbsG,
    workoutPercent: ([0, 50, 100].includes(row.workoutPercent)
      ? row.workoutPercent
      : 50) as NutritionGoals["workoutPercent"],
  };
}

export async function saveNutritionGoals(userId: string, goals: NutritionGoals) {
  const values = { userId, ...goals, updatedAt: new Date() };
  await getDb()
    .insert(nutritionGoals)
    .values(values)
    .onConflictDoUpdate({ target: nutritionGoals.userId, set: values });
}

export async function listFoodEntriesSince(params: { userId: string; since: Date }) {
  return getDb()
    .select()
    .from(foodEntries)
    .where(
      and(
        eq(foodEntries.userId, params.userId),
        eq(foodEntries.status, "active"),
        gte(foodEntries.eatenAt, params.since),
      ),
    )
    .orderBy(asc(foodEntries.eatenAt));
}

export async function getFoodEntryById(params: { userId: string; entryId: string }) {
  const [row] = await getDb()
    .select()
    .from(foodEntries)
    .where(
      and(
        eq(foodEntries.id, params.entryId),
        eq(foodEntries.userId, params.userId),
        eq(foodEntries.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function setFoodEntryPhoto(params: {
  entryId: string;
  photoKey: string | null;
  photoStatus: "stored" | "deleted" | "failed";
}) {
  await getDb()
    .update(foodEntries)
    .set({ photoKey: params.photoKey, photoStatus: params.photoStatus, updatedAt: new Date() })
    .where(eq(foodEntries.id, params.entryId));
}

// Any status: a deleted entry still owns its stored photo until the photo is removed.
export async function getFoodEntryPhoto(entryId: string) {
  const [row] = await getDb()
    .select({
      id: foodEntries.id,
      userId: foodEntries.userId,
      status: foodEntries.status,
      photoKey: foodEntries.photoKey,
    })
    .from(foodEntries)
    .where(eq(foodEntries.id, entryId))
    .limit(1);
  return row ?? null;
}

// Bot photos whose upload never happened (older entries, or the store was down).
export async function listFoodEntriesMissingPhoto(params: { since: Date; limit: number }) {
  return getDb()
    .select({ id: foodEntries.id, telegramFileId: foodEntries.telegramFileId })
    .from(foodEntries)
    .where(
      and(
        eq(foodEntries.status, "active"),
        isNotNull(foodEntries.telegramFileId),
        isNull(foodEntries.photoStatus),
        gte(foodEntries.createdAt, params.since),
      ),
    )
    .orderBy(desc(foodEntries.createdAt))
    .limit(params.limit);
}
