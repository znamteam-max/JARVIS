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

function intervalsHeaders() {
  const auth = Buffer.from(`API_KEY:${requireEnv("INTERVALS_API_KEY")}`).toString("base64");
  return { authorization: `Basic ${auth}`, accept: "application/json" };
}

// Personal API key from intervals.icu/settings; basic auth with the literal user "API_KEY".
// Athlete "0" means the owner of the key.
export async function fetchIntervals(path: string, params: Record<string, string>) {
  const url = new URL(`${INTERVALS_API}/athlete/${getEnv().INTERVALS_ATHLETE_ID}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: intervalsHeaders(), cache: "no-store" });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    throw new IntervalsApiError(
      `Intervals ${path} request failed: ${response.status} ${body}`,
      response.status,
    );
  }
  return (await response.json()) as Array<Record<string, unknown>>;
}

export type IntervalsStream = { type: string; data: Array<number | null> | null };

// Per-second data of one activity (seconds from start, watts, heart rate, cadence).
export async function fetchIntervalsActivityStreams(activityId: string) {
  const url = new URL(`${INTERVALS_API}/activity/${encodeURIComponent(activityId)}/streams`);
  url.searchParams.set("types", "time,watts,heartrate,cadence");
  const response = await fetch(url, { headers: intervalsHeaders(), cache: "no-store" });
  if (!response.ok) {
    throw new IntervalsApiError(
      `Intervals streams request failed: ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as IntervalsStream[];
}
