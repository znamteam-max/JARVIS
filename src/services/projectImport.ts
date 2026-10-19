import {
  createProject,
  findProjectForReport,
  insertProjectEntries,
  updateProject,
} from "@/db/queries/projects";
import { redactSecrets, resolveReportOwner } from "@/services/projectSessionReports";

const MAX_TEXT_CHARS = 300;
const MAX_README_CHARS = 1500;

export type ImportedCommit = { sha: string; subject: string; date: string };

export type ImportedProject = {
  folder: string;
  repo: string | null;
  git: boolean;
  branch: string | null;
  // Uncommitted changes in the working copy.
  dirty: number | null;
  commits: ImportedCommit[];
  readme: string | null;
};

// Work projects never get in, whatever the computer sends: the folder, owner or repo name
// starting with RNGN is enough.
export function isWorkProject(project: { folder: string; repo: string | null }) {
  const [owner, name] = project.repo ? project.repo.split("/") : [];
  return [project.folder, owner, name].some((value) => value && /^rngn/i.test(value));
}

function clip(text: string, max: number) {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// "Импорт проектов" from ops/claude-code/import-projects.mjs: every project folder on the
// owner's computer becomes a project (or finds its own), with its recent commits in "Сделано"
// and its README and local state kept for the summary. Commits share the GitHub sync's key
// (the sha), so nothing lands twice.
export async function importProjects(projects: ImportedProject[], now = new Date()) {
  const owner = await resolveReportOwner();
  if (!owner) return null;
  const results: Array<{ title: string; created: boolean; added: number; skipped?: string }> = [];
  for (const item of projects) {
    if (isWorkProject(item)) {
      results.push({ title: item.folder, created: false, added: 0, skipped: "work" });
      continue;
    }
    let project = await findProjectForReport(owner.id, item.repo, item.folder);
    const created = !project;
    if (!project) {
      project = await createProject({
        userId: owner.id,
        title: item.folder,
        status: "active",
        repo: item.repo,
      });
    }
    const rows = item.commits.flatMap((commit) => {
      const date = new Date(commit.date);
      const text = clip(redactSecrets(commit.subject), MAX_TEXT_CHARS);
      if (!commit.sha || !text || Number.isNaN(date.getTime())) return [];
      return [
        {
          kind: "done",
          // A repo on GitHub shares the sync's key; a local-only one is just "git".
          source: item.repo ? "github" : "git",
          externalId: commit.sha,
          text,
          occurredAt: date,
          metadata: {
            sha: commit.sha.slice(0, 7),
            url: item.repo ? `https://github.com/${item.repo}/commit/${commit.sha}` : null,
            local: true,
          },
        },
      ];
    });
    const added = await insertProjectEntries(owner.id, project.id, rows);
    await updateProject(
      owner.id,
      project.id,
      {},
      {
        touch: false,
        metadata: {
          local: {
            git: item.git,
            branch: item.branch,
            dirty: item.dirty,
            importedAt: now.toISOString(),
          },
          readme: item.readme ? clip(redactSecrets(item.readme), MAX_README_CHARS) : null,
        },
      },
    );
    results.push({ title: project.title, created, added: added.length });
  }
  return results;
}
