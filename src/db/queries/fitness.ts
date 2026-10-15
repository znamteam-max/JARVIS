import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "../client";
import { fitnessActivities, integrationSyncState, wellnessDays } from "../schema";
import type { FitnessActivityRow, WellnessDayRow } from "@/domain/intervalsFitness";

export async function upsertFitnessActivities(
  userId: string,
  source: string,
  rows: FitnessActivityRow[],
) {
  if (!rows.length) return [];
  return getDb()
    .insert(fitnessActivities)
    .values(rows.map((row) => ({ ...row, userId, source })))
    .onConflictDoUpdate({
      target: [fitnessActivities.source, fitnessActivities.externalId],
      set: {
        name: sql`excluded.name`,
        sportType: sql`excluded.sport_type`,
        startAt: sql`excluded.start_at`,
        distanceM: sql`excluded.distance_m`,
        movingTimeS: sql`excluded.moving_time_s`,
        elapsedTimeS: sql`excluded.elapsed_time_s`,
        elevationGainM: sql`excluded.elevation_gain_m`,
        averageHeartrate: sql`excluded.average_heartrate`,
        maxHeartrate: sql`excluded.max_heartrate`,
        calories: sql`excluded.calories`,
        trainingLoad: sql`excluded.training_load`,
        raw: sql`excluded.raw`,
        updatedAt: new Date(),
      },
    })
    .returning();
}

export async function getLatestFitnessActivityStart(userId: string, source: string) {
  const [row] = await getDb()
    .select({ startAt: fitnessActivities.startAt })
    .from(fitnessActivities)
    .where(and(eq(fitnessActivities.userId, userId), eq(fitnessActivities.source, source)))
    .orderBy(desc(fitnessActivities.startAt))
    .limit(1);
  return row?.startAt ?? null;
}

export async function listFitnessActivitiesSince(userId: string, since: Date) {
  return getDb()
    .select()
    .from(fitnessActivities)
    .where(and(eq(fitnessActivities.userId, userId), gte(fitnessActivities.startAt, since)))
    .orderBy(desc(fitnessActivities.startAt));
}

export async function markFitnessActivityIdsNotified(ids: string[], at: Date) {
  if (!ids.length) return;
  await getDb()
    .update(fitnessActivities)
    .set({ notifiedAt: at, updatedAt: new Date() })
    .where(inArray(fitnessActivities.id, ids));
}

export async function markAllFitnessActivitiesNotified(userId: string, at: Date) {
  await getDb()
    .update(fitnessActivities)
    .set({ notifiedAt: at, updatedAt: new Date() })
    .where(and(eq(fitnessActivities.userId, userId), isNull(fitnessActivities.notifiedAt)));
}

export async function upsertWellnessDays(userId: string, source: string, rows: WellnessDayRow[]) {
  if (!rows.length) return [];
  return getDb()
    .insert(wellnessDays)
    .values(rows.map((row) => ({ ...row, userId, source })))
    .onConflictDoUpdate({
      target: [wellnessDays.userId, wellnessDays.source, wellnessDays.day],
      set: {
        restingHr: sql`excluded.resting_hr`,
        hrv: sql`excluded.hrv`,
        sleepSecs: sql`excluded.sleep_secs`,
        sleepScore: sql`excluded.sleep_score`,
        steps: sql`excluded.steps`,
        raw: sql`excluded.raw`,
        updatedAt: new Date(),
      },
    })
    .returning();
}

export async function listWellnessDaysSince(userId: string, sinceDay: string) {
  return getDb()
    .select()
    .from(wellnessDays)
    .where(and(eq(wellnessDays.userId, userId), gte(wellnessDays.day, sinceDay)))
    .orderBy(desc(wellnessDays.day));
}

export async function getIntegrationSyncState(key: string) {
  const [row] = await getDb()
    .select()
    .from(integrationSyncState)
    .where(eq(integrationSyncState.key, key))
    .limit(1);
  return row ?? null;
}

export async function setIntegrationSyncState(key: string, at: Date, error: string | null) {
  const values = { key, lastSyncAt: at, lastError: error, updatedAt: new Date() };
  await getDb()
    .insert(integrationSyncState)
    .values(values)
    .onConflictDoUpdate({ target: integrationSyncState.key, set: values });
}
