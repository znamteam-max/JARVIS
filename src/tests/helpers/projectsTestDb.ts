import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/db/schema";

// The projects tables from the production migrations themselves, in memory: never reads
// DATABASE_URL. Tests point getDb() at the returned db.
export async function createProjectsTestDb(userIds: string[]) {
  const pg = await PGlite.create();
  await pg.exec(`
    create schema assistant;
    create table assistant.users (id uuid primary key);
    ${userIds.map((id) => `insert into assistant.users (id) values ('${id}');`).join("\n")}
  `);
  for (const file of ["0018_projects.sql", "0019_project_session_reports.sql"]) {
    const migration = readFileSync(`drizzle/${file}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pg.exec(statement);
    }
  }
  return { pg, db: drizzle(pg, { schema }) };
}
