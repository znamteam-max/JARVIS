import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { DateTime } from "luxon";

import { getDb } from "../client";
import { foodEntries } from "../schema";
import type { FoodEstimate } from "@/domain/foodEstimate";

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
