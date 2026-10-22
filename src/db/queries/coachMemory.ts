import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

import { getDb } from "../client";
import { coachMemories, coachMessages, healthRecords, type HealthItem } from "../schema";

// A fact she removed is not brought back from old messages for this long.
const REMOVED_BLOCK_MS = 30 * 24 * 60 * 60 * 1000;

// The same fact said twice in other words or case is one fact; a copied list number
// ("2. …", "- …") or date ("… (21.10)") does not make it another one.
export function normalizeFact(fact: string) {
  return fact
    .replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "")
    .replace(/\s*\(\d{2}\.\d{2}(?:\.\d{4})?\)\s*$/, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export async function listActiveMemories(userId: string) {
  return getDb()
    .select()
    .from(coachMemories)
    .where(and(eq(coachMemories.userId, userId), eq(coachMemories.status, "active")))
    .orderBy(asc(coachMemories.createdAt));
}

// New facts from the coach's answer: duplicates of what is kept already are skipped;
// facts the athlete took back are switched off by their exact (normalized) text.
export async function applyMemoryChanges(params: {
  userId: string;
  remember: string[];
  forget: string[];
}) {
  const active = await listActiveMemories(params.userId);
  const recentlyRemoved = await getDb()
    .select({ fact: coachMemories.fact })
    .from(coachMemories)
    .where(
      and(
        eq(coachMemories.userId, params.userId),
        eq(coachMemories.status, "removed"),
        gte(coachMemories.updatedAt, new Date(Date.now() - REMOVED_BLOCK_MS)),
      ),
    );
  const known = new Set(
    [...active, ...recentlyRemoved].map((memory) => normalizeFact(memory.fact)),
  );
  const forget = new Set(params.forget.map(normalizeFact).filter(Boolean));
  let removed = 0;
  for (const memory of active) {
    if (!forget.has(normalizeFact(memory.fact))) continue;
    await getDb()
      .update(coachMemories)
      .set({ status: "removed", updatedAt: new Date() })
      .where(eq(coachMemories.id, memory.id));
    removed += 1;
  }
  let added = 0;
  for (const raw of params.remember) {
    const fact = raw.trim().slice(0, 300);
    const key = normalizeFact(fact);
    if (!key || known.has(key)) continue;
    known.add(key);
    await getDb().insert(coachMemories).values({ userId: params.userId, fact });
    added += 1;
  }
  return { added, removed };
}

export async function removeMemoryAt(userId: string, position: number) {
  const active = await listActiveMemories(userId);
  const memory = active[position - 1];
  if (!memory) return null;
  await getDb()
    .update(coachMemories)
    .set({ status: "removed", updatedAt: new Date() })
    .where(eq(coachMemories.id, memory.id));
  return memory;
}

export async function listHealthRecords(userId: string) {
  return getDb()
    .select()
    .from(healthRecords)
    .where(eq(healthRecords.userId, userId))
    .orderBy(sql`${healthRecords.takenOn} desc nulls last`, desc(healthRecords.createdAt));
}

export async function insertHealthRecord(params: {
  userId: string;
  takenOn: string | null;
  lab: string | null;
  title: string;
  items: HealthItem[];
  summary: string;
  source: "upload" | "owner";
}) {
  const [row] = await getDb().insert(healthRecords).values(params).returning();
  return row;
}

export async function deleteHealthRecordAt(userId: string, position: number) {
  const records = await listHealthRecords(userId);
  const record = records[position - 1];
  if (!record) return null;
  // The record and what was said about it in the chat go together.
  await getDb().transaction(async (tx) => {
    await tx
      .delete(coachMessages)
      .where(
        and(
          eq(coachMessages.userId, userId),
          sql`${coachMessages.metadata}->>'healthRecordId' = ${record.id}`,
        ),
      );
    await tx
      .delete(healthRecords)
      .where(and(eq(healthRecords.id, record.id), eq(healthRecords.userId, userId)));
  });
  return record;
}
