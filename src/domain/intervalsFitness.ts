import { DateTime } from "luxon";

// Intervals.icu (fed by Garmin) uses Strava's sport type names, so the activity
// cards and weekly summary from stravaActivity.ts are reused as is.

export type FitnessActivityRow = {
  externalId: string;
  name: string;
  sportType: string;
  startAt: Date;
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  elevationGainM: number;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  calories: number | null;
  trainingLoad: number | null;
  raw: Record<string, unknown>;
};

export type WellnessDayRow = {
  day: string;
  restingHr: number | null;
  hrv: number | null;
  sleepSecs: number | null;
  sleepScore: number | null;
  steps: number | null;
  raw: Record<string, unknown>;
};

export function mapIntervalsActivity(
  raw: Record<string, unknown>,
  timezone: string,
): FitnessActivityRow | null {
  const id = raw.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  // Strava-sourced activities come back as empty stubs: Strava forbids forwarding them.
  if (raw.source === "STRAVA" && !raw.moving_time) return null;
  const startAt =
    typeof raw.start_date === "string"
      ? new Date(raw.start_date)
      : typeof raw.start_date_local === "string"
        ? DateTime.fromISO(raw.start_date_local, { zone: timezone }).toUTC().toJSDate()
        : null;
  if (!startAt || Number.isNaN(+startAt)) return null;
  return {
    externalId: String(id),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Тренировка",
    sportType: String(raw.type ?? "Workout"),
    startAt,
    distanceM: roundOrZero(raw.distance),
    movingTimeS: roundOrZero(raw.moving_time),
    elapsedTimeS: roundOrZero(raw.elapsed_time),
    elevationGainM: roundOrZero(raw.total_elevation_gain),
    averageHeartrate: roundOrNull(raw.average_heartrate),
    maxHeartrate: roundOrNull(raw.max_heartrate),
    calories: roundOrNull(raw.calories),
    trainingLoad: roundOrNull(raw.icu_training_load),
    raw,
  };
}

export function mapIntervalsWellness(raw: Record<string, unknown>): WellnessDayRow | null {
  if (typeof raw.id !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.id)) return null;
  const row = {
    day: raw.id,
    restingHr: roundOrNull(raw.restingHR),
    hrv: roundOrNull(raw.hrv),
    sleepSecs: roundOrNull(raw.sleepSecs),
    sleepScore: roundOrNull(raw.sleepScore),
    steps: roundOrNull(raw.steps),
    raw,
  };
  const hasData = [row.restingHr, row.hrv, row.sleepSecs, row.sleepScore, row.steps].some(
    (value) => value !== null,
  );
  return hasData ? row : null;
}

export function formatWellnessSummary(days: WellnessDayRow[]) {
  const sorted = [...days].sort((a, b) => b.day.localeCompare(a.day));
  if (!sorted.length) return "😴 Данных о сне и восстановлении пока нет.";
  const latest = sorted[0];
  const lines = [`😴 Сон и восстановление (${DateTime.fromISO(latest.day).toFormat("dd.LL")})`];
  const today = [
    latest.sleepSecs ? `Сон ${formatSleep(latest.sleepSecs)}` : null,
    latest.sleepScore ? `оценка ${latest.sleepScore}` : null,
  ].filter(Boolean);
  if (today.length) lines.push(today.join(", "));
  const vitals = [
    latest.hrv ? `HRV ${latest.hrv}` : null,
    latest.restingHr ? `пульс покоя ${latest.restingHr}` : null,
    latest.steps ? `шаги ${latest.steps}` : null,
  ].filter(Boolean);
  if (vitals.length) lines.push(vitals.join(" · "));

  const sleep = average(sorted.map((day) => day.sleepSecs));
  const hrv = average(sorted.map((day) => day.hrv));
  const resting = average(sorted.map((day) => day.restingHr));
  const week = [
    sleep ? `сон ${formatSleep(sleep)}` : null,
    hrv ? `HRV ${hrv}` : null,
    resting ? `пульс покоя ${resting}` : null,
  ].filter(Boolean);
  if (sorted.length > 1 && week.length) {
    lines.push(`В среднем за ${sorted.length} дн.: ${week.join(" · ")}`);
  }
  return lines.join("\n");
}

function formatSleep(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

function average(values: Array<number | null>) {
  const present = values.filter((value): value is number => value !== null && value > 0);
  return present.length
    ? Math.round(present.reduce((sum, value) => sum + value, 0) / present.length)
    : null;
}

function roundOrZero(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function roundOrNull(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}
