import { eq } from "drizzle-orm";

import { getOwnerTimezone } from "@/lib/env";

import { getDb } from "../client";
import { users, type User } from "../schema";

export type TelegramProfile = {
  id: number | string | bigint;
  username?: string;
  firstName?: string;
};

export function toTelegramBigInt(id: number | string | bigint): bigint {
  return typeof id === "bigint" ? id : BigInt(id);
}

export async function getUserByTelegramId(
  telegramUserId: number | string | bigint,
): Promise<User | null> {
  const [user] = await getDb()
    .select()
    .from(users)
    .where(eq(users.telegramUserId, toTelegramBigInt(telegramUserId)))
    .limit(1);
  if (!user) return null;
  return user.role === "owner" ? { ...user, timezone: getOwnerTimezone() } : user;
}

export async function getUserById(userId: string): Promise<User | null> {
  const [user] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
  return user ?? null;
}

// Planner users only: digests, check-ins and calendar import must never reach someone
// who only uses the coach bot.
export async function listUsers(): Promise<User[]> {
  return getDb().select().from(users).where(eq(users.role, "owner"));
}

// The coach bot's athlete: a user row of its own, outside the planner.
export async function createAthleteUser(profile: TelegramProfile & { timezone: string }) {
  const now = new Date();
  const [user] = await getDb()
    .insert(users)
    .values({
      telegramUserId: toTelegramBigInt(profile.id),
      telegramUsername: profile.username,
      firstName: profile.firstName,
      timezone: profile.timezone,
      role: "athlete",
      isOnboarded: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.telegramUserId,
      set: { telegramUsername: profile.username, firstName: profile.firstName, updatedAt: now },
    })
    .returning();
  return user;
}

export async function getOrCreateOwnerUser(profile: TelegramProfile): Promise<User> {
  const now = new Date();
  const [user] = await getDb()
    .insert(users)
    .values({
      telegramUserId: toTelegramBigInt(profile.id),
      telegramUsername: profile.username,
      firstName: profile.firstName,
      timezone: getOwnerTimezone(),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.telegramUserId,
      set: {
        telegramUsername: profile.username,
        firstName: profile.firstName,
        updatedAt: now,
      },
    })
    .returning();

  return { ...user, timezone: getOwnerTimezone() };
}

export async function markUserOnboarded(userId: string) {
  await getDb()
    .update(users)
    .set({ isOnboarded: true, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function updateUserTimezone(userId: string, timezone: string): Promise<User> {
  const [user] = await getDb()
    .update(users)
    .set({ timezone, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return user;
}
