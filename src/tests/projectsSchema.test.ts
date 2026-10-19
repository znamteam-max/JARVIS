import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));

import { PROJECTS_SCHEMA_FILES, PROJECTS_SCHEMA_STATEMENTS } from "@/db/projectsSchemaSql";
import { createProjectFromApp, listProjectsView } from "@/services/projects";

const OWNER = "00000000-0000-4000-8000-000000000001";

describe("the Projects tables in code", () => {
  it("are exactly the statements of the migration files", () => {
    const fromFiles = PROJECTS_SCHEMA_FILES.flatMap((file) =>
      readFileSync(`drizzle/${file}`, "utf8")
        .replace(/\r\n/g, "\n")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean),
    );
    expect(PROJECTS_SCHEMA_STATEMENTS).toEqual(fromFiles);
  });
});

describe("a production database without the Projects tables", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await PGlite.create();
    // Only what already exists in production: no migration has been run.
    await pg.exec(`
      create schema assistant;
      create table assistant.users (id uuid primary key);
      insert into assistant.users (id) values ('${OWNER}');
    `);
    state.db = drizzle(pg, { schema });
  });

  afterAll(async () => {
    await pg.close();
  });

  async function tables() {
    const rows = await pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'assistant' order by 1",
    );
    return rows.rows.map((row) => row.table_name);
  }

  it("gets them on the first request, even two at once, and keeps working", async () => {
    expect(await tables()).toEqual(["users"]);
    const [first, second] = await Promise.all([listProjectsView(OWNER), listProjectsView(OWNER)]);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(await tables()).toEqual([
      "project_entries",
      "project_session_reports",
      "projects",
      "users",
    ]);
    await createProjectFromApp({ userId: OWNER, title: "JARVIS" });
    expect((await listProjectsView(OWNER)).map((row) => row.title)).toEqual(["JARVIS"]);
  });
});
