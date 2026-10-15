import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "../client";
import { stravaActivities, stravaConnections, users } from "../schema";
import type { StravaActivityRow } from "@/domain/stravaActivity";

export async function upsertStravaConnection(params: {
  userId: string;
  athleteId: bigint;
  athleteName: string | null;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
  scope: string | null;
}) {
  const values = { ...params, status: "active", lastSyncError: null, updatedAt: new Date() };
  const [row] = await getDb()
    .insert(stravaConnections)
    .values(values)
    .onConflictDoUpdate({ target: stravaConnections.userId, set: values })
    .returning();
  return row ?? null;
}

export async function getStravaConnection(userId: string) {
  const [row] = await getDb()
    .select()
    .from(stravaConnections)
    .where(and(eq(stravaConnections.userId, userId), eq(stravaConnections.status, "active")))
    .limit(1);
  return row ?? null;
}

export async function listActiveStravaConnections() {
  return getDb()
    .select({
      connection: stravaConnections,
      telegramUserId: users.telegramUserId,
      timezone: users.timezone,
    })
    .from(stravaConnections)
    .innerJoin(users, eq(users.id, stravaConnections.userId))
    .where(eq(stravaConnections.status, "active"));
}

export async function updateStravaTokens(params: {
  connectionId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
}) {
  await getDb()
    .update(stravaConnections)
    .set({
      encryptedAccessToken: params.encryptedAccessToken,
      encryptedRefreshToken: params.encryptedRefreshToken,
      expiresAt: params.expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(stravaConnections.id, params.connectionId));
}

export async function markStravaSynced(params: {
  connectionId: string;
  at: Date;
  error: string | null;
}) {
  await getDb()
    .update(stravaConnections)
    .set({ lastSyncAt: params.at, lastSyncError: params.error, updatedAt: new Date() })
    .where(eq(stravaConnections.id, params.connectionId));
}

export async function disconnectStrava(userId: string) {
  await getDb()
    .update(stravaConnections)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(eq(stravaConnections.userId, userId));
}

export async function upsertStravaActivities(userId: string, rows: StravaActivityRow[]) {
  if (!rows.length) return [];
  return getDb()
    .insert(stravaActivities)
    .values(rows.map((row) => ({ ...row, userId })))
    .onConflictDoUpdate({
      target: stravaActivities.stravaId,
      set: {
        name: sql`excluded.name`,
        sportType: sql`excluded.sport_type`,
        distanceM: sql`excluded.distance_m`,
        movingTimeS: sql`excluded.moving_time_s`,
        elapsedTimeS: sql`excluded.elapsed_time_s`,
        elevationGainM: sql`excluded.elevation_gain_m`,
        averageHeartrate: sql`excluded.average_heartrate`,
        maxHeartrate: sql`excluded.max_heartrate`,
        calories: sql`excluded.calories`,
        sufferScore: sql`excluded.suffer_score`,
        raw: sql`excluded.raw`,
        updatedAt: new Date(),
      },
    })
    .returning();
}

export async function getLatestStravaActivityStart(userId: string) {
  const [row] = await getDb()
    .select({ startAt: stravaActivities.startAt })
    .from(stravaActivities)
    .where(eq(stravaActivities.userId, userId))
    .orderBy(desc(stravaActivities.startAt))
    .limit(1);
  return row?.startAt ?? null;
}

export async function listStravaActivitiesSince(userId: string, since: Date) {
  return getDb()
    .select()
    .from(stravaActivities)
    .where(and(eq(stravaActivities.userId, userId), gte(stravaActivities.startAt, since)))
    .orderBy(desc(stravaActivities.startAt));
}

export async function markStravaActivitiesNotified(userId: string, at: Date) {
  await getDb()
    .update(stravaActivities)
    .set({ notifiedAt: at, updatedAt: new Date() })
    .where(and(eq(stravaActivities.userId, userId), isNull(stravaActivities.notifiedAt)));
}

export async function markStravaActivityIdsNotified(ids: string[], at: Date) {
  if (!ids.length) return;
  await getDb()
    .update(stravaActivities)
    .set({ notifiedAt: at, updatedAt: new Date() })
    .where(inArray(stravaActivities.id, ids));
}
