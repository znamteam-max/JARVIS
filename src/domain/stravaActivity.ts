import { DateTime } from "luxon";

// Strava data stays out of the AI pipeline: the API agreement forbids using it for
// model training and restricts processing, so everything here is plain arithmetic.

export type StravaActivityRow = {
  stravaId: bigint;
  name: string;
  sportType: string;
  startAt: Date;
  timezone: string | null;
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  elevationGainM: number;
  averageHeartrate: number | null;
  maxHeartrate: number | null;
  calories: number | null;
  sufferScore: number | null;
  raw: Record<string, unknown>;
};

export function mapStravaActivity(raw: Record<string, unknown>): StravaActivityRow | null {
  const id = raw.id;
  const startDate = typeof raw.start_date === "string" ? new Date(raw.start_date) : null;
  if (
    (typeof id !== "number" && typeof id !== "string") ||
    !startDate ||
    Number.isNaN(+startDate)
  ) {
    return null;
  }
  const timezone =
    typeof raw.timezone === "string" ? (raw.timezone.split(" ").pop() ?? null) : null;
  return {
    stravaId: BigInt(id),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Тренировка",
    sportType: String(raw.sport_type ?? raw.type ?? "Workout"),
    startAt: startDate,
    timezone,
    distanceM: roundOrZero(raw.distance),
    movingTimeS: roundOrZero(raw.moving_time),
    elapsedTimeS: roundOrZero(raw.elapsed_time),
    elevationGainM: roundOrZero(raw.total_elevation_gain),
    averageHeartrate: roundOrNull(raw.average_heartrate),
    maxHeartrate: roundOrNull(raw.max_heartrate),
    calories: roundOrNull(raw.calories),
    sufferScore: roundOrNull(raw.suffer_score),
    raw,
  };
}

type ActivityView = Pick<
  StravaActivityRow,
  | "name"
  | "sportType"
  | "startAt"
  | "distanceM"
  | "movingTimeS"
  | "elevationGainM"
  | "averageHeartrate"
  | "maxHeartrate"
>;

const SPORTS: Record<string, { label: string; icon: string; pace?: "km" | "100m" | "speed" }> = {
  Run: { label: "Бег", icon: "🏃", pace: "km" },
  TrailRun: { label: "Трейл", icon: "🏃", pace: "km" },
  VirtualRun: { label: "Бег (дорожка)", icon: "🏃", pace: "km" },
  Walk: { label: "Ходьба", icon: "🚶", pace: "km" },
  Hike: { label: "Поход", icon: "🥾", pace: "km" },
  Ride: { label: "Велосипед", icon: "🚴", pace: "speed" },
  GravelRide: { label: "Гревел", icon: "🚴", pace: "speed" },
  MountainBikeRide: { label: "МТБ", icon: "🚵", pace: "speed" },
  VirtualRide: { label: "Велотренажёр", icon: "🚴", pace: "speed" },
  Swim: { label: "Плавание", icon: "🏊", pace: "100m" },
  OpenWaterSwim: { label: "Открытая вода", icon: "🏊", pace: "100m" },
  WeightTraining: { label: "Силовая", icon: "🏋️" },
  Workout: { label: "Тренировка", icon: "💪" },
  Crossfit: { label: "Кроссфит", icon: "💪" },
  Yoga: { label: "Йога", icon: "🧘" },
  Rowing: { label: "Гребля", icon: "🚣", pace: "speed" },
  Elliptical: { label: "Эллипс", icon: "💪" },
  NordicSki: { label: "Беговые лыжи", icon: "⛷", pace: "km" },
  AlpineSki: { label: "Горные лыжи", icon: "⛷" },
};

export function sportLabel(sportType: string) {
  return SPORTS[sportType]?.label ?? sportType;
}

// "10,2 км, 5:32 /км" for a run, "1,5 км, 2:05 /100 м" for a swim: for the coach's data.
export function formatDistanceAndPace(
  activity: Pick<ActivityView, "sportType" | "distanceM" | "movingTimeS">,
) {
  if (activity.distanceM <= 0) return null;
  const pace = formatPace(activity as ActivityView, SPORTS[activity.sportType]?.pace);
  return [formatKm(activity.distanceM), pace].filter(Boolean).join(", ");
}

export function formatActivityCard(activity: ActivityView) {
  const sport = SPORTS[activity.sportType];
  const metrics = [
    activity.distanceM > 0 ? formatKm(activity.distanceM) : null,
    formatDuration(activity.movingTimeS),
    formatPace(activity, sport?.pace),
  ].filter(Boolean);
  const extra = [
    activity.averageHeartrate
      ? `Пульс ${activity.averageHeartrate}${activity.maxHeartrate ? ` (макс ${activity.maxHeartrate})` : ""}`
      : null,
    activity.elevationGainM > 0 ? `Набор ${activity.elevationGainM} м` : null,
  ].filter(Boolean);
  return [
    `${sport?.icon ?? "💪"} ${sportLabel(activity.sportType)} — «${activity.name}»`,
    metrics.join(" · "),
    ...(extra.length ? [extra.join(" · ")] : []),
  ].join("\n");
}

export function formatWeekSummary(params: {
  activities: ActivityView[];
  timezone: string;
  now: Date;
}) {
  const end = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const start = end.minus({ days: 7 });
  const header = `📊 Тренировки за 7 дней (${start.toFormat("dd.LL")}–${end.toFormat("dd.LL")})`;
  if (!params.activities.length) return `${header}\nТренировок нет.`;

  const bySport = new Map<string, { count: number; distanceM: number; movingTimeS: number }>();
  for (const activity of params.activities) {
    const entry = bySport.get(activity.sportType) ?? { count: 0, distanceM: 0, movingTimeS: 0 };
    entry.count += 1;
    entry.distanceM += activity.distanceM;
    entry.movingTimeS += activity.movingTimeS;
    bySport.set(activity.sportType, entry);
  }
  const totalDistance = params.activities.reduce((sum, a) => sum + a.distanceM, 0);
  const totalTime = params.activities.reduce((sum, a) => sum + a.movingTimeS, 0);
  const lines = [
    header,
    `Всего: ${params.activities.length} · ${formatHours(totalTime)}${totalDistance > 0 ? ` · ${formatKm(totalDistance)}` : ""}`,
  ];
  for (const [sportType, entry] of [...bySport.entries()].sort(
    (a, b) => b[1].movingTimeS - a[1].movingTimeS,
  )) {
    const distance = entry.distanceM > 0 ? ` · ${formatKm(entry.distanceM)}` : "";
    lines.push(
      `• ${sportLabel(sportType)}: ${entry.count}${distance} · ${formatHours(entry.movingTimeS)}`,
    );
  }
  lines.push("", "Последние:");
  for (const activity of [...params.activities]
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime())
    .slice(0, 7)) {
    const day = DateTime.fromJSDate(activity.startAt, { zone: "utc" })
      .setZone(params.timezone)
      .toFormat("dd.LL");
    const distance = activity.distanceM > 0 ? ` ${formatKm(activity.distanceM)} ·` : "";
    lines.push(
      `• ${day} ${sportLabel(activity.sportType)}${distance} ${formatDuration(activity.movingTimeS)}`,
    );
  }
  return lines.join("\n");
}

// A brand-new connection imports a month of history; only workouts from the last two
// days are worth a separate message, everything older is summarised once.
export function selectActivitiesToAnnounce<T extends { startAt: Date; notifiedAt: Date | null }>(
  activities: T[],
  now: Date,
) {
  const cutoff = now.getTime() - 48 * 60 * 60 * 1000;
  return activities.filter(
    (activity) => !activity.notifiedAt && activity.startAt.getTime() >= cutoff,
  );
}

function formatPace(activity: ActivityView, mode: "km" | "100m" | "speed" | undefined) {
  if (!mode || activity.distanceM <= 0 || activity.movingTimeS <= 0) return null;
  if (mode === "speed") {
    const kmh = activity.distanceM / 1000 / (activity.movingTimeS / 3600);
    return `${kmh.toFixed(1).replace(".", ",")} км/ч`;
  }
  const unit = mode === "km" ? 1000 : 100;
  const secondsPerUnit = Math.round(activity.movingTimeS / (activity.distanceM / unit));
  const minutes = Math.floor(secondsPerUnit / 60);
  const seconds = String(secondsPerUnit % 60).padStart(2, "0");
  return `${minutes}:${seconds} /${mode === "km" ? "км" : "100 м"}`;
}

function formatKm(distanceM: number) {
  return `${(distanceM / 1000).toFixed(1).replace(".", ",")} км`;
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function formatHours(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (!hours) return `${minutes} мин`;
  return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
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
