import { getIntegrationSyncState, setIntegrationSyncState } from "@/db/queries/fitness";
import {
  getProject,
  insertProjectEntries,
  listProjectsWithRepo,
  updateProject,
} from "@/db/queries/projects";
import type { Project } from "@/db/schema";
import { fetchRepoCommits, GithubApiError, type GithubCommit } from "@/integrations/github";
import { logger } from "@/lib/logger";
import { getProjectView, ProjectError } from "@/services/projects";

const SYNC_KEY = "github_projects";
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
// The first sync brings recent history; later ones just catch up.
const FIRST_SYNC_COMMITS = 30;
const SYNC_COMMITS = 100;
const MAX_TEXT_CHARS = 300;

export type GithubSyncError = "repo_not_found" | "bad_token" | "rate_limited" | "github_failed";

// A commit becomes a "done" line: its subject, its date, its sha as the dedupe key.
// Merge commits only repeat the work already listed, so they are skipped.
export function commitEntry(commit: GithubCommit) {
  if (commit.parents > 1) return null;
  const subject = commit.message.split("\n")[0].trim();
  if (!subject) return null;
  return {
    kind: "done",
    source: "github",
    externalId: commit.sha,
    text: subject.length > MAX_TEXT_CHARS ? `${subject.slice(0, MAX_TEXT_CHARS - 1)}…` : subject,
    occurredAt: commit.committedAt,
    metadata: { url: commit.url, author: commit.author, sha: commit.sha.slice(0, 7) },
  };
}

export function githubErrorCode(error: unknown): GithubSyncError {
  if (error instanceof GithubApiError) {
    if (error.status === 404) return "repo_not_found";
    if (error.status === 401) return "bad_token";
    if (error.status === 403 || error.status === 429) return "rate_limited";
  }
  return "github_failed";
}

// Pulls the repo's latest commits into the project's log; never throws.
export async function syncProjectCommits(project: Project, now = new Date()) {
  if (!project.repo) return { added: 0 };
  const first = typeof project.metadata?.githubSyncedAt !== "string";
  try {
    const commits = await fetchRepoCommits(project.repo, first ? FIRST_SYNC_COMMITS : SYNC_COMMITS);
    const rows = commits.flatMap((commit) => commitEntry(commit) ?? []);
    const added = await insertProjectEntries(project.userId, project.id, rows);
    await updateProject(
      project.userId,
      project.id,
      {},
      { touch: false, metadata: { githubSyncedAt: now.toISOString(), githubError: null } },
    );
    return { added: added.length };
  } catch (error) {
    const code = githubErrorCode(error);
    logger.warn("GitHub commit sync failed", {
      projectId: project.id,
      repo: project.repo,
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    await updateProject(
      project.userId,
      project.id,
      {},
      { touch: false, metadata: { githubError: code, githubErrorAt: now.toISOString() } },
    );
    return { added: 0, error: code };
  }
}

// «Синхронизировать» in the card, and right after a repo is linked.
export async function syncProjectCommitsNow(userId: string, projectId: string) {
  const project = await getProject(userId, projectId);
  if (!project) throw new ProjectError("not_found");
  if (!project.repo) throw new ProjectError("no_repo");
  await syncProjectCommits(project);
  return getProjectView(userId, projectId);
}

// On the scheduler tick, every 30 minutes: all linked projects that are not done.
export async function syncGithubProjectsIfDue(now = new Date()) {
  const state = await getIntegrationSyncState(SYNC_KEY);
  if (now.getTime() - (state?.lastSyncAt?.getTime() ?? 0) < SYNC_INTERVAL_MS) {
    return { synced: false, reason: "not_due" };
  }
  // Claim the slot first, so overlapping ticks do not both sync.
  await setIntegrationSyncState(SYNC_KEY, now, null);
  let added = 0;
  const failed: string[] = [];
  for (const project of await listProjectsWithRepo()) {
    const result = await syncProjectCommits(project, now);
    added += result.added;
    if (result.error) failed.push(`${project.repo}: ${result.error}`);
  }
  if (failed.length) await setIntegrationSyncState(SYNC_KEY, now, failed.join("; ").slice(0, 500));
  return { synced: true, added, failed: failed.length };
}
