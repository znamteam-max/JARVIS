import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { collectProjects } from "../../ops/claude-code/import-projects.mjs";

describe("the project folders this computer sends", () => {
  let base: string;
  const git = (dir: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
      { stdio: "ignore", windowsHide: true },
    );

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "jarvis-import-"));
    const app = join(base, "ZNAMBO-App");
    mkdirSync(app);
    git(app, "init", "-q");
    git(app, "checkout", "-q", "-b", "main");
    git(app, "remote", "add", "origin", "https://github.com/znamteam-max/ZNAMBO-App.git");
    writeFileSync(join(app, "README.md"), "# App\n\n![badge](x.svg)\nЛичный проект.\n");
    git(app, "add", ".");
    git(app, "commit", "-q", "-m", "First screen");
    writeFileSync(join(app, "draft.txt"), "wip");

    mkdirSync(join(base, "Notes"));
    writeFileSync(join(base, "Notes", "README.md"), "Заметки без git");

    const work = join(base, "RNGN_STUDIO");
    mkdirSync(work);
    git(work, "init", "-q");
    mkdirSync(join(base, ".hidden"));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("are the owner's folders with commits, branch, local changes and README, never work", () => {
    const projects = collectProjects(base);
    expect(projects.map((project: { folder: string }) => project.folder).sort()).toEqual([
      "Notes",
      "ZNAMBO-App",
    ]);
    const app = projects.find((project: { folder: string }) => project.folder === "ZNAMBO-App");
    expect(app).toMatchObject({
      repo: "znamteam-max/ZNAMBO-App",
      git: true,
      branch: "main",
      dirty: 1,
      readme: "# App\n\nЛичный проект.",
    });
    expect(app.commits).toHaveLength(1);
    expect(app.commits[0]).toMatchObject({ subject: "First screen" });
    expect(app.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(new Date(app.commits[0].date).getTime())).toBe(false);

    expect(projects.find((project: { folder: string }) => project.folder === "Notes")).toEqual({
      folder: "Notes",
      repo: null,
      git: false,
      branch: null,
      dirty: null,
      commits: [],
      readme: "Заметки без git",
    });
  });
});
