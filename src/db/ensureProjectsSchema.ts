import { sql } from "drizzle-orm";

import { getDb } from "./client";
import { PROJECTS_SCHEMA_STATEMENTS } from "./projectsSchemaSql";

let ready: Promise<void> | null = null;

// The Projects tables create themselves on first use, once per process: every statement is
// IF NOT EXISTS, and an advisory lock keeps two cold starts from racing. Existing tables
// and data are never touched. A failure is retried on the next call.
export function ensureProjectsSchema() {
  ready ??= getDb()
    .transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('jarvis_projects_schema'))`);
      for (const statement of PROJECTS_SCHEMA_STATEMENTS) await tx.execute(sql.raw(statement));
    })
    .catch((error: unknown) => {
      ready = null;
      throw error;
    });
  return ready;
}

// getDb() for the Projects queries, with their tables guaranteed to exist.
export async function projectsDb() {
  await ensureProjectsSchema();
  return getDb();
}
