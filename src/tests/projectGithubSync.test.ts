import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createProjectsTestDb } from "./helpers/projectsTestDb";

const state = vi.hoisted(() => ({
  db: null as unknown,
  syncState: new Map<string, { lastSyncAt: Date; lastError: string | null }>(),
}));
vi.mock("@/db/client", () => ({ getDb: () => state.db }));
vi.mock("@/db/queries/fitness", () => ({
  getIntegrationSyncState: async (key: string) => state.syncState.get(key) ?? null,
  setIntegrationSyncState: async (key: string, at: Date, error: string | null) => {
    state.syncState.set(key, { lastSyncAt: at, lastError: error });
  },
}));

import { getProject } from "@/db/queries/projects";
import { fetchRepoCommits, GithubApiError, githubTokenFor } from "@/integrations/github";
import { resetEnvCacheForTests } from "@/lib/env";
import {
  commitEntry,
  githubErrorCode,
  syncGithubProjectsIfDue,
  syncProjectCommits,
  syncProjectCommitsNow,
} from "@/services/projectGithubSync";
import { createProjectFromApp, getProjectView, updateProjectFromApp } from "@/services/projects";

const OWNER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function apiCommit(sha: string, message: string, date: string, parents = 1) {
  return {
    sha,
    html_url: `https://github.com/znamteam-max/JARVIS/commit/${sha}`,
    parents: Array.from({ length: parents }, () => ({})),
    author: { login: "owner" },
    commit: { message, author: { name: "Owner", date }, committer: { date } },
  };
}

type FetchCall = { url: URL; headers: Record<string, string> };

function stubGithub(respond: (url: URL) => { status: number; body?: unknown }) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const { status, body } = respond(url);
      return new Response(body === undefined ? "" : JSON.stringify(body), { status });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKENS;
  resetEnvCacheForTests();
});

describe("a commit in the project's log", () => {
  const commit = {
    sha: "b67face6be599c7a83c4a30b0aea177e392f3e3a",
    message: "JARVIS: reminders at exact times\n\nLong body that stays on GitHub.",
    url: "https://github.com/znamteam-max/JARVIS/commit/b67face",
    committedAt: new Date("2026-10-18T14:58:04Z"),
    author: "Owner",
    parents: 1,
  };

  it("is a done line with the subject, the commit date and the sha as its key", () => {
    expect(commitEntry(commit)).toEqual({
      kind: "done",
      source: "github",
      externalId: commit.sha,
      text: "JARVIS: reminders at exact times",
      occurredAt: commit.committedAt,
      metadata: { url: commit.url, author: "Owner", sha: "b67face" },
    });
  });

  it("merge commits and empty messages are skipped, long subjects cut", () => {
    expect(commitEntry({ ...commit, parents: 2 })).toBeNull();
    expect(commitEntry({ ...commit, message: "  \nbody" })).toBeNull();
    expect(commitEntry({ ...commit, message: "x".repeat(400) })?.text).toHaveLength(300);
  });

  it("GitHub failures become a short reason for the card", () => {
    expect(githubErrorCode(new GithubApiError("x", 404))).toBe("repo_not_found");
    expect(githubErrorCode(new GithubApiError("x", 401))).toBe("bad_token");
    expect(githubErrorCode(new GithubApiError("x", 403))).toBe("rate_limited");
    expect(githubErrorCode(new Error("timeout"))).toBe("github_failed");
  });
});

describe("which GitHub token a repo uses", () => {
  it("the owner's own token from GITHUB_TOKENS, else GITHUB_TOKEN, else none", () => {
    expect(githubTokenFor("znamteam-max/JARVIS")).toBeNull();
    process.env.GITHUB_TOKEN = "default-token";
    process.env.GITHUB_TOKENS = "Some-Org=org-token; other-org = other-token";
    resetEnvCacheForTests();
    expect(githubTokenFor("some-org/Some-Project")).toBe("org-token");
    expect(githubTokenFor("OTHER-ORG/Another-Project")).toBe("other-token");
    expect(githubTokenFor("znamteam-max/JARVIS")).toBe("default-token");
  });
});

describe("reading commits from GitHub", () => {
  it("asks for the latest commits with the repo's token and maps them", async () => {
    process.env.GITHUB_TOKEN = "default-token";
    resetEnvCacheForTests();
    const calls = stubGithub(() => ({
      status: 200,
      body: [apiCommit("aaa1111", "Second", "2026-10-18T10:00:00Z")],
    }));
    const commits = await fetchRepoCommits("znamteam-max/JARVIS", 30);
    expect(calls[0].url.pathname).toBe("/repos/znamteam-max/JARVIS/commits");
    expect(calls[0].url.searchParams.get("per_page")).toBe("30");
    expect(calls[0].headers.authorization).toBe("Bearer default-token");
    expect(commits).toEqual([
      {
        sha: "aaa1111",
        message: "Second",
        url: "https://github.com/znamteam-max/JARVIS/commit/aaa1111",
        committedAt: new Date("2026-10-18T10:00:00Z"),
        author: "Owner",
        parents: 1,
      },
    ]);
  });

  it("an empty repo has no commits; a missing one is an error", async () => {
    stubGithub(() => ({ status: 409 }));
    expect(await fetchRepoCommits("o/empty", 30)).toEqual([]);
    stubGithub(() => ({ status: 404 }));
    await expect(fetchRepoCommits("o/missing", 30)).rejects.toMatchObject({ status: 404 });
  });
});

describe("commits in the projects' logs", () => {
  let pg: PGlite;

  beforeAll(async () => {
    const test = await createProjectsTestDb([OWNER, OTHER]);
    pg = test.pg;
    state.db = test.db;
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    await pg.exec("delete from assistant.projects");
    state.syncState.clear();
  });

  async function linkedProject(userId = OWNER, repo = "znamteam-max/JARVIS") {
    const view = await createProjectFromApp({ userId, title: "JARVIS", repo });
    // Last touched a while ago, so the sync can show what "updated" follows.
    await pg.query("update assistant.projects set last_activity_at = $1 where id = $2", [
      "2026-09-01T00:00:00Z",
      view.id,
    ]);
    return (await getProject(userId, view.id))!;
  }

  it("the first sync brings recent history, skips merges and dates the project by its last commit", async () => {
    const project = await linkedProject();
    const calls = stubGithub(() => ({
      status: 200,
      body: [
        apiCommit("ccc3333", "Merge pull request #7", "2026-10-12T10:00:00Z", 2),
        apiCommit("bbb2222", "Projects tab", "2026-10-11T10:00:00Z"),
        apiCommit("aaa1111", "Projects schema", "2026-10-10T10:00:00Z"),
      ],
    }));

    expect(await syncProjectCommits(project, new Date("2026-10-19T09:00:00Z"))).toEqual({
      added: 2,
    });

    expect(calls[0].url.searchParams.get("per_page")).toBe("30");
    const view = await getProjectView(OWNER, project.id);
    expect(view.done.map((row) => [row.text, row.source, row.url])).toEqual([
      ["Projects tab", "github", "https://github.com/znamteam-max/JARVIS/commit/bbb2222"],
      ["Projects schema", "github", "https://github.com/znamteam-max/JARVIS/commit/aaa1111"],
    ]);
    expect(view.lastActivityAt).toBe("2026-10-11T10:00:00.000Z");
    expect(view.github).toEqual({ syncedAt: "2026-10-19T09:00:00.000Z", error: null });
  });

  it("later syncs catch up without repeating commits already in the log", async () => {
    const project = await linkedProject();
    stubGithub(() => ({
      status: 200,
      body: [apiCommit("aaa1111", "One", "2026-10-10T10:00:00Z")],
    }));
    await syncProjectCommits(project);
    const synced = (await getProject(OWNER, project.id))!;
    const calls = stubGithub(() => ({
      status: 200,
      body: [
        apiCommit("bbb2222", "Two", "2026-10-11T10:00:00Z"),
        apiCommit("aaa1111", "One", "2026-10-10T10:00:00Z"),
      ],
    }));

    expect(await syncProjectCommits(synced)).toEqual({ added: 1 });
    expect(calls[0].url.searchParams.get("per_page")).toBe("100");
    expect((await getProjectView(OWNER, project.id)).done).toHaveLength(2);
  });

  it("a GitHub failure is shown on the card and the log stays; the next good sync clears it", async () => {
    const project = await linkedProject();
    stubGithub(() => ({
      status: 200,
      body: [apiCommit("aaa1111", "One", "2026-10-10T10:00:00Z")],
    }));
    await syncProjectCommits(project);
    stubGithub(() => ({ status: 404 }));

    expect(await syncProjectCommits(project)).toEqual({ added: 0, error: "repo_not_found" });
    const failed = await getProjectView(OWNER, project.id);
    expect(failed.github?.error).toBe("repo_not_found");
    expect(failed.done).toHaveLength(1);

    stubGithub(() => ({ status: 200, body: [] }));
    await syncProjectCommits(project);
    expect((await getProjectView(OWNER, project.id)).github?.error).toBeNull();
  });

  it("the scheduler syncs every linked project that is not done, at most every 30 minutes", async () => {
    await linkedProject(OWNER, "znamteam-max/JARVIS");
    await linkedProject(OTHER, "znamteam-max/MESH-Family-Bot");
    const finished = await linkedProject(OWNER, "znamteam-max/old");
    await updateProjectFromApp({ userId: OWNER, projectId: finished.id, status: "done" });
    await createProjectFromApp({ userId: OWNER, title: "Без репозитория" });
    const calls = stubGithub((url) => ({
      status: 200,
      body: [apiCommit(`sha-${url.pathname}`, "Commit", "2026-10-10T10:00:00Z")],
    }));
    const now = new Date("2026-10-19T09:00:00Z");

    expect(await syncGithubProjectsIfDue(now)).toEqual({ synced: true, added: 2, failed: 0 });
    expect(calls.map((call) => call.url.pathname).sort()).toEqual([
      "/repos/znamteam-max/JARVIS/commits",
      "/repos/znamteam-max/MESH-Family-Bot/commits",
    ]);

    const soon = new Date(now.getTime() + 10 * 60 * 1000);
    expect(await syncGithubProjectsIfDue(soon)).toEqual({ synced: false, reason: "not_due" });
    expect(calls).toHaveLength(2);
  });

  it("«Обновить» needs a linked repo and the owner's own project", async () => {
    const plain = await createProjectFromApp({ userId: OWNER, title: "Без репозитория" });
    await expect(syncProjectCommitsNow(OWNER, plain.id)).rejects.toMatchObject({
      code: "no_repo",
    });
    const project = await linkedProject();
    await expect(syncProjectCommitsNow(OTHER, project.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
