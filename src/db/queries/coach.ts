import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";

import { getDb } from "../client";
import { coachMessages, coachProfiles, rideFiles } from "../schema";

export async function getCoachProfile(userId: string) {
  const [row] = await getDb()
    .select()
    .from(coachProfiles)
    .where(eq(coachProfiles.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function saveCoachProfile(params: {
  userId: string;
  profile: string;
  settings: Record<string, unknown>;
}) {
  const values = { ...params, updatedAt: new Date() };
  await getDb()
    .insert(coachProfiles)
    .values(values)
    .onConflictDoUpdate({ target: coachProfiles.userId, set: values });
}

export async function listActiveCoachMessages(userId: string, limit: number) {
  const rows = await getDb()
    .select()
    .from(coachMessages)
    .where(and(eq(coachMessages.userId, userId), eq(coachMessages.status, "active")))
    .orderBy(desc(coachMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function insertCoachMessage(params: {
  userId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
}) {
  const [row] = await getDb()
    .insert(coachMessages)
    .values({ ...params, metadata: params.metadata ?? {} })
    .returning();
  return row;
}

export async function archiveCoachConversation(userId: string) {
  await getDb()
    .update(coachMessages)
    .set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(coachMessages.userId, userId), eq(coachMessages.status, "active")));
}

export async function countCoachQuestionsSince(userId: string, since: Date) {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        eq(coachMessages.role, "user"),
        gte(coachMessages.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

// Zwift and Magene export the same ride a few minutes apart: keep one per ±15 minutes.
export async function upsertRideFile(params: {
  userId: string;
  startedAt: Date;
  fileName: string | null;
  source: string;
  summary: Record<string, unknown>;
}) {
  const window = 15 * 60 * 1000;
  const [existing] = await getDb()
    .select({ id: rideFiles.id })
    .from(rideFiles)
    .where(
      and(
        eq(rideFiles.userId, params.userId),
        gte(rideFiles.startedAt, new Date(params.startedAt.getTime() - window)),
        lte(rideFiles.startedAt, new Date(params.startedAt.getTime() + window)),
      ),
    )
    .limit(1);
  if (existing) {
    const [row] = await getDb()
      .update(rideFiles)
      .set({ ...params, updatedAt: new Date() })
      .where(eq(rideFiles.id, existing.id))
      .returning();
    return row;
  }
  const [row] = await getDb().insert(rideFiles).values(params).returning();
  return row;
}

export async function listRideFilesSince(userId: string, since: Date) {
  return getDb()
    .select()
    .from(rideFiles)
    .where(and(eq(rideFiles.userId, userId), gte(rideFiles.startedAt, since)))
    .orderBy(asc(rideFiles.startedAt));
}
