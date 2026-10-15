import { getEnv, requireEnv } from "@/lib/env";
import { createSignedState, verifySignedState } from "@/lib/secrets";

const STRAVA_OAUTH = "https://www.strava.com/oauth";
const STRAVA_API = "https://www.strava.com/api/v3";
const STATE_TTL_MS = 30 * 60 * 1000;

type StravaState = { telegramUserId: string; issuedAt: number };

export type StravaTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
  athlete?: { id: number; firstname?: string; lastname?: string };
};

// The bot hands out a signed, short-lived link instead of a bare Telegram id, so the
// connect URL cannot be replayed to attach someone else's Strava account.
export function createStravaConnectLink(telegramUserId: string, now = Date.now()) {
  const state = createSignedState(
    { telegramUserId, issuedAt: now } satisfies StravaState,
    requireEnv("APP_ENCRYPTION_KEY"),
  );
  return `${getEnv().NEXT_PUBLIC_APP_URL}/api/strava/oauth/start?state=${encodeURIComponent(state)}`;
}

export function readStravaState(state: string, now = Date.now()) {
  const parsed = verifySignedState<StravaState>(state, requireEnv("APP_ENCRYPTION_KEY"));
  if (!parsed || now - parsed.issuedAt > STATE_TTL_MS) return null;
  return parsed;
}

export function buildStravaAuthorizeUrl(state: string) {
  const url = new URL(`${STRAVA_OAUTH}/authorize`);
  url.searchParams.set("client_id", requireEnv("STRAVA_CLIENT_ID"));
  url.searchParams.set("redirect_uri", `${getEnv().NEXT_PUBLIC_APP_URL}/api/strava/oauth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", "read,activity:read_all");
  url.searchParams.set("state", state);
  return url.toString();
}

export function exchangeStravaCode(code: string) {
  return postStravaToken({ code, grant_type: "authorization_code" });
}

export function refreshStravaToken(refreshToken: string) {
  return postStravaToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
}

export async function fetchStravaActivities(params: {
  accessToken: string;
  after: Date;
  page: number;
}) {
  const url = new URL(`${STRAVA_API}/athlete/activities`);
  url.searchParams.set("after", String(Math.floor(params.after.getTime() / 1000)));
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(params.page));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${params.accessToken}` },
    cache: "no-store",
  });
  if (!response.ok) throw await stravaApiError("activities", response);
  return (await response.json()) as Array<Record<string, unknown>>;
}

// Since mid-2026 Strava answers 403 to apps whose owner has no Strava subscription.
export class StravaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  get forbidden() {
    return this.status === 403;
  }
}

async function stravaApiError(request: string, response: Response) {
  const body = (await response.text().catch(() => "")).slice(0, 300);
  return new StravaApiError(
    `Strava ${request} request failed: ${response.status} ${body}`,
    response.status,
  );
}

async function postStravaToken(params: Record<string, string>) {
  const response = await fetch(`${STRAVA_OAUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("STRAVA_CLIENT_ID"),
      client_secret: requireEnv("STRAVA_CLIENT_SECRET"),
      ...params,
    }),
    cache: "no-store",
  });
  if (!response.ok) throw await stravaApiError("token", response);
  return (await response.json()) as StravaTokenResponse;
}
