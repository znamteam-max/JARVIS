import { getEnv, requireEnv } from "@/lib/env";

const INTERVALS_API = "https://intervals.icu/api/v1";

export class IntervalsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Whose Intervals.icu to read: the owner's from env, or a coach-bot athlete's own key.
export type IntervalsCredentials = { athleteId: string; apiKey: string };

function ownerCredentials(): IntervalsCredentials {
  return { athleteId: getEnv().INTERVALS_ATHLETE_ID, apiKey: requireEnv("INTERVALS_API_KEY") };
}

function intervalsHeaders(credentials: IntervalsCredentials) {
  const auth = Buffer.from(`API_KEY:${credentials.apiKey}`).toString("base64");
  return { authorization: `Basic ${auth}`, accept: "application/json" };
}

// Personal API key from intervals.icu/settings; basic auth with the literal user "API_KEY".
// Athlete "0" means the owner of the key.
export async function fetchIntervals(
  path: string,
  params: Record<string, string>,
  credentials: IntervalsCredentials = ownerCredentials(),
) {
  const url = new URL(
    `${INTERVALS_API}/athlete/${encodeURIComponent(credentials.athleteId)}/${path}`,
  );
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: intervalsHeaders(credentials), cache: "no-store" });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new IntervalsApiError(
      `Intervals ${path} request failed: ${response.status} ${body}`,
      response.status,
    );
  }
  return (await response.json()) as Array<Record<string, unknown>>;
}

// The athlete record: per-sport threshold HR, max HR, FTP and zones, resting HR.
export async function fetchIntervalsAthlete(
  credentials: IntervalsCredentials = ownerCredentials(),
) {
  const url = new URL(`${INTERVALS_API}/athlete/${encodeURIComponent(credentials.athleteId)}`);
  const response = await fetch(url, { headers: intervalsHeaders(credentials), cache: "no-store" });
  if (!response.ok) {
    throw new IntervalsApiError(
      `Intervals athlete request failed: ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

export type IntervalsStream = { type: string; data: Array<number | null> | null };

// Per-second data of one activity (seconds from start, watts, heart rate, cadence).
export async function fetchIntervalsActivityStreams(
  activityId: string,
  credentials: IntervalsCredentials = ownerCredentials(),
) {
  const url = new URL(`${INTERVALS_API}/activity/${encodeURIComponent(activityId)}/streams`);
  url.searchParams.set("types", "time,watts,heartrate,cadence");
  const response = await fetch(url, { headers: intervalsHeaders(credentials), cache: "no-store" });
  if (!response.ok) {
    throw new IntervalsApiError(
      `Intervals streams request failed: ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as IntervalsStream[];
}
