import { and, eq, gte, sql } from "drizzle-orm";

import { getDb } from "../client";
import { webSessions } from "../schema";

export async function insertWebLoginRequest(params: {
  userId: string;
  tokenHash: string;
  code: string;
  device: string;
  expiresAt: Date;
}) {
  const [row] = await getDb().insert(webSessions).values(params).returning();
  return row;
}

export async function countWebLoginRequestsSince(since: Date) {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(webSessions)
    .where(gte(webSessions.createdAt, since));
  return row?.count ?? 0;
}

export async function getWebSessionByTokenHash(tokenHash: string) {
  const [row] = await getDb()
    .select()
    .from(webSessions)
    .where(eq(webSessions.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export async function getWebSessionById(id: string) {
  const [row] = await getDb().select().from(webSessions).where(eq(webSessions.id, id)).limit(1);
  return row ?? null;
}

// Only moves from the expected status, so a double tap or a stale button changes nothing.
export async function transitionWebSession(params: {
  id: string;
  from: string;
  to: "active" | "denied" | "revoked";
  at: Date;
  expiresAt?: Date;
}) {
  const [row] = await getDb()
    .update(webSessions)
    .set({
      status: params.to,
      updatedAt: params.at,
      ...(params.to === "active" ? { approvedAt: params.at, lastSeenAt: params.at } : {}),
      ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
    })
    .where(and(eq(webSessions.id, params.id), eq(webSessions.status, params.from)))
    .returning();
  return row ?? null;
}

export async function touchWebSession(params: { id: string; at: Date; expiresAt: Date }) {
  await getDb()
    .update(webSessions)
    .set({ lastSeenAt: params.at, expiresAt: params.expiresAt })
    .where(eq(webSessions.id, params.id));
}
