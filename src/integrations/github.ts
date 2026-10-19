import { getEnv } from "@/lib/env";

const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type GithubCommit = {
  sha: string;
  message: string;
  url: string | null;
  committedAt: Date;
  author: string | null;
  // More than one parent = a merge commit.
  parents: number;
};

// The token for the repo's owner from GITHUB_TOKENS ("owner=token;owner=token"),
// else GITHUB_TOKEN, else none (public repos only).
export function githubTokenFor(repo: string): string | null {
  const env = getEnv();
  const owner = repo.split("/")[0]?.toLowerCase() ?? "";
  for (const pair of (env.GITHUB_TOKENS ?? "").split(/[;,\n]/)) {
    const [name, token] = pair.split("=").map((part) => part.trim());
    if (name && token && name.toLowerCase() === owner) return token;
  }
  return env.GITHUB_TOKEN?.trim() || null;
}

// The latest commits on the default branch, newest first.
export async function fetchRepoCommits(repo: string, perPage: number): Promise<GithubCommit[]> {
  const [owner, name] = repo.split("/");
  const url = new URL(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits`,
  );
  url.searchParams.set("per_page", String(perPage));
  const token = githubTokenFor(repo);
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "jarvis-planner",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // An empty repository has no commits yet.
  if (response.status === 409) return [];
  if (!response.ok) {
    throw new GithubApiError(`GitHub commits request failed: ${response.status}`, response.status);
  }
  const body = (await response.json()) as Array<{
    sha?: string;
    html_url?: string;
    parents?: unknown[];
    author?: { login?: string } | null;
    commit?: {
      message?: string;
      author?: { name?: string; date?: string } | null;
      committer?: { date?: string } | null;
    };
  }>;
  return body.flatMap((row) => {
    const date = row.commit?.committer?.date ?? row.commit?.author?.date;
    if (!row.sha || !date) return [];
    return [
      {
        sha: row.sha,
        message: row.commit?.message ?? "",
        url: row.html_url ?? null,
        committedAt: new Date(date),
        author: row.commit?.author?.name ?? row.author?.login ?? null,
        parents: Array.isArray(row.parents) ? row.parents.length : 1,
      },
    ];
  });
}
