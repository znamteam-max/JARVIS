import { and, asc, eq, gte, lt } from "drizzle-orm";
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
