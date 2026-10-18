import { and, desc, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../client";
import { athleteConnections, users } from "../schema";
import { toTelegramBigInt, type TelegramProfile } from "./users";

export async function getAthleteConnection(telegramUserId: number | string | bigint) {
  const [row] = await getDb()
    .select()
    .from(athleteConnections)
    .where(eq(athleteConnections.telegramUserId, toTelegramBigInt(telegramUserId)))
    .limit(1);
  return row ?? null;
}

export async function getAthleteConnectionByUserId(userId: string) {
  const [row] = await getDb()
    .select()
    .from(athleteConnections)
    .where(eq(athleteConnections.userId, userId))
    .limit(1);
  return row ?? null;
}

// A first /start in the coach bot: one request per person, kept until the owner decides.
export async function requestAthleteAccess(profile: TelegramProfile) {
  const now = new Date();
  const [row] = await getDb()
    .insert(athleteConnections)
    .values({
      telegramUserId: toTelegramBigInt(profile.id),
      telegramUsername: profile.username,
      firstName: profile.firstName,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: athleteConnections.telegramUserId })
    .returning();
  return { created: Boolean(row), connection: row ?? (await getAthleteConnection(profile.id))! };
}

export async function setAthleteDecision(params: {
  telegramUserId: number | string | bigint;
  status: "approved" | "denied";
  userId?: string | null;
}) {
  const [row] = await getDb()
    .update(athleteConnections)
    .set({ status: params.status, userId: params.userId ?? null, updatedAt: new Date() })
    .where(eq(athleteConnections.telegramUserId, toTelegramBigInt(params.telegramUserId)))
    .returning();
  return row ?? null;
}

export async function saveAthleteIntervalsKey(params: {
  userId: string;
  athleteId: string;
  encryptedKey: string;
}) {
  await getDb()
    .update(athleteConnections)
    .set({
      intervalsAthleteId: params.athleteId,
      intervalsApiKey: params.encryptedKey,
      updatedAt: new Date(),
    })
    .where(eq(athleteConnections.userId, params.userId));
}

// Everyone the owner let in, newest first, with their user rows.
export async function listApprovedAthletes() {
  return getDb()
    .select({ connection: athleteConnections, user: users })
    .from(athleteConnections)
    .innerJoin(users, eq(users.id, athleteConnections.userId))
    .where(eq(athleteConnections.status, "approved"))
    .orderBy(desc(athleteConnections.updatedAt));
}

// Approved athletes whose Intervals.icu is connected, with their user rows.
export async function listConnectedAthletes() {
  return getDb()
    .select({ connection: athleteConnections, user: users })
    .from(athleteConnections)
    .innerJoin(users, eq(users.id, athleteConnections.userId))
    .where(
      and(
        eq(athleteConnections.status, "approved"),
        isNotNull(athleteConnections.intervalsApiKey),
        isNotNull(athleteConnections.intervalsAthleteId),
      ),
    );
}
