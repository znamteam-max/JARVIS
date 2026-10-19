import { eq, sql } from "drizzle-orm";

import { getDb } from "../client";
import { projectSessionReports, type ProjectSessionReport } from "../schema";

// The newest report of a session replaces the previous one that was not processed yet.
export async function upsertSessionReport(params: {
  userId: string;
  projectId: string;
  sessionId: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  receivedAt: Date;
}) {
  const fresh = {
    projectId: params.projectId,
    payload: params.payload,
    payloadHash: params.payloadHash,
    receivedAt: params.receivedAt,
    attempts: 0,
    lastError: null,
    updatedAt: params.receivedAt,
  };
  const [row] = await getDb()
    .insert(projectSessionReports)
    .values({
      userId: params.userId,
      sessionId: params.sessionId,
      ...fresh,
      createdAt: params.receivedAt,
    })
    .onConflictDoUpdate({
      target: [projectSessionReports.userId, projectSessionReports.sessionId],
      set: fresh,
    })
    .returning();
  return row;
}

// Reports ready to process: something new, the session quiet for `quietMs` (a burst of
// turns becomes one model call) or waiting longer than `maxWaitMs`, and not claimed by
// another tick. Claiming counts an attempt; a report that keeps failing is left alone.
export async function claimDueSessionReports(params: {
  now: Date;
  quietMs: number;
  maxWaitMs: number;
  staleClaimMs: number;
  maxAttempts: number;
  limit: number;
}): Promise<ProjectSessionReport[]> {
  const now = params.now.toISOString();
  const quietBefore = new Date(params.now.getTime() - params.quietMs).toISOString();
  const waitBefore = new Date(params.now.getTime() - params.maxWaitMs).toISOString();
  const claimBefore = new Date(params.now.getTime() - params.staleClaimMs).toISOString();
  const t = projectSessionReports;
  return getDb()
    .update(t)
    .set({ claimedAt: sql`${now}::timestamptz`, attempts: sql`${t.attempts} + 1` })
    .where(
      sql`${t.id} in (
        select ${t.id} from ${t}
        where ${t.payload} is not null
          and ${t.payloadHash} is distinct from ${t.processedHash}
          and ${t.attempts} < ${params.maxAttempts}
          and (${t.claimedAt} is null or ${t.claimedAt} < ${claimBefore}::timestamptz)
          and (${t.receivedAt} <= ${quietBefore}::timestamptz
            or coalesce(${t.processedAt}, ${t.createdAt}) <= ${waitBefore}::timestamptz)
        order by ${t.receivedAt}
        limit ${params.limit}
        for update skip locked
      )`,
    )
    .returning();
}

// Done: remember what the session reported so far and drop the raw text, unless a newer
// report arrived while the model was writing (that one stays for the next tick).
export async function finishSessionReport(params: {
  id: string;
  processedHash: string;
  done: string | null;
  next: string[];
  at: Date;
}) {
  const t = projectSessionReports;
  await getDb()
    .update(t)
    .set({
      processedHash: params.processedHash,
      processedAt: params.at,
      done: params.done,
      next: params.next,
      claimedAt: null,
      lastError: null,
      attempts: 0,
      payload: sql`case when ${t.payloadHash} = ${params.processedHash} then null else ${t.payload} end`,
      updatedAt: params.at,
    })
    .where(eq(t.id, params.id));
}

export async function failSessionReport(id: string, error: string) {
  await getDb()
    .update(projectSessionReports)
    .set({ claimedAt: null, lastError: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(projectSessionReports.id, id));
}
