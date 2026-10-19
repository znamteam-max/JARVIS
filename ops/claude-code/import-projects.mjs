#!/usr/bin/env node
// Puts every project folder of this computer into the JARVIS Projects tab: each folder in
// ~/GitHub (or --dir) becomes a project with its recent commits, branch, uncommitted
// changes and README. Work projects (RNGN*, plus the config's "exclude") are skipped here,
// and the server refuses them too. Safe to run again: nothing is added twice.
//
//   node ops/claude-code/import-projects.mjs            send
//   node ops/claude-code/import-projects.mjs --dry-run  only show what would be sent
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ALWAYS_EXCLUDED, isExcluded, readConfig, repoFromRemote } from "./jarvis-report.mjs";

const COMMITS = 30;
const README_CHARS = 1500;

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function readme(dir) {
  for (const name of ["README.md", "readme.md", "README.MD", "README.txt", "README"]) {
    const path = join(dir, name);
    if (existsSync(path)) {
      return readFileSync(path, "utf8")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, README_CHARS);
    }
  }
  return null;
}

// One folder as the server takes it, or null for a work project.
export function collectProject(dir, folder, exclude = ALWAYS_EXCLUDED) {
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  const isGit = Boolean(root) && resolve(root) === resolve(dir);
  const repo = isGit ? repoFromRemote(git(dir, ["remote", "get-url", "origin"])) : null;
  if (isExcluded(exclude, { repo, folder })) return null;
  if (!isGit) {
    return {
      folder,
      repo: null,
      git: false,
      branch: null,
      dirty: null,
      commits: [],
      readme: readme(dir),
    };
  }
  const log = git(dir, ["log", "-n", String(COMMITS), "--no-merges", "--format=%H%x1f%cI%x1f%s"]);
  const status = git(dir, ["status", "--porcelain"]);
  return {
    folder,
    repo,
    git: true,
    branch: git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]) || null,
    dirty: status === null ? null : status.split("\n").filter(Boolean).length,
    commits: (log ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, date, subject] = line.split("\x1f");
        return { sha, date, subject: subject ?? "" };
      }),
    readme: readme(dir),
  };
}

export function collectProjects(baseDir, exclude = ALWAYS_EXCLUDED) {
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => collectProject(join(baseDir, entry.name), entry.name, exclude))
    .filter(Boolean);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dirIndex = args.indexOf("--dir");
  const baseDir = dirIndex >= 0 ? args[dirIndex + 1] : join(homedir(), "GitHub");
  const config = readConfig();
  const projects = collectProjects(baseDir, config?.exclude ?? ALWAYS_EXCLUDED);
  for (const project of projects) {
    console.log(
      `${project.folder.padEnd(32)} ${project.repo ?? (project.git ? "(git, no GitHub)" : "(not git)")}` +
        ` · ${project.commits.length} commits${project.dirty ? ` · ${project.dirty} uncommitted` : ""}`,
    );
  }
  if (dryRun) {
    console.log(`\n${projects.length} projects would be sent (dry run).`);
    return;
  }
  if (!config) {
    console.log("\nNo ~/.claude/jarvis-report.json: nothing sent.");
    process.exitCode = 1;
    return;
  }
  const response = await fetch(new URL("/api/projects/import", config.url), {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify({ projects }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    console.log(`\nImport failed: HTTP ${response.status} ${body?.error ?? ""}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nIn JARVIS:");
  for (const result of body.projects) {
    console.log(
      `  ${result.title.padEnd(32)} ${result.skipped ? "skipped (work)" : `${result.created ? "new" : "existing"}, +${result.added} done`}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
