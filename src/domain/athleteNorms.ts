import { activityWatts } from "@/domain/activityDedupe";

// "Высокий пульс" means high for her, not by a textbook formula: an athlete whose easy runs
// always run at a high heart rate was once told an ordinary run was "interval level".

type NormActivity = {
  sportType: string;
  movingTimeS: number;
  distanceM: number;
  averageHeartrate: number | null;
  raw: unknown;
};

export type IntervalsSportSettings = {
  types: string[];
  lthr: number | null;
  maxHr: number | null;
  ftp: number | null;
  hrZones: number[];
};

const GROUPS = [
  { label: "Бег", types: ["Run", "TrailRun", "VirtualRun"], pace: "km" as const },
  {
    label: "Велосипед",
    types: ["Ride", "VirtualRide", "GravelRide", "MountainBikeRide"],
    pace: null,
  },
  { label: "Плавание", types: ["Swim", "OpenWaterSwim"], pace: "100m" as const },
];

const MIN_MINUTES = 15;

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function paceText(secondsPerUnit: number, unit: "km" | "100m") {
  const rounded = Math.round(secondsPerUnit);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")} /${unit === "km" ? "км" : "100 м"}`;
}

const numberOrNull = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
};

// Intervals.icu GET /athlete/{id}: per-sport threshold HR, max HR, FTP and HR zones.
export function parseIntervalsAthlete(raw: unknown) {
  const athlete = (raw ?? {}) as Record<string, unknown>;
  const settings = Array.isArray(athlete.sportSettings) ? athlete.sportSettings : [];
  const sports: IntervalsSportSettings[] = settings
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .map((entry) => ({
      types: Array.isArray(entry.types) ? entry.types.map(String) : [],
      lthr: numberOrNull(entry.lthr),
      maxHr: numberOrNull(entry.max_hr),
      ftp: numberOrNull(entry.ftp),
      hrZones: Array.isArray(entry.hr_zones)
        ? entry.hr_zones.map(numberOrNull).filter((value): value is number => value !== null)
        : [],
    }))
    .filter((sport) => sport.types.length && (sport.lthr || sport.maxHr || sport.ftp));
  return { sports, restingHr: numberOrNull(athlete.icu_resting_hr) };
}

export function athleteNormsBlock(params: {
  activities: NormActivity[];
  restingHr: number[];
  intervals?: { sports: IntervalsSportSettings[]; restingHr: number | null } | null;
}) {
  const lines: string[] = [];
  for (const group of GROUPS) {
    const sessions = params.activities.filter(
      (activity) =>
        group.types.includes(activity.sportType) &&
        activity.averageHeartrate &&
        activity.movingTimeS >= MIN_MINUTES * 60,
    );
    if (!sessions.length) continue;
    const heartRates = sessions.map((activity) => activity.averageHeartrate as number);
    const parts = [
      `${group.label}: ${sessions.length} трен.`,
      sessions.length >= 3
        ? `средний пульс обычно ${Math.round(quantile(heartRates, 0.25))}–${Math.round(quantile(heartRates, 0.75))} (медиана ${Math.round(quantile(heartRates, 0.5))})`
        : `средний пульс ${heartRates.map(Math.round).join(", ")}`,
    ];
    if (group.pace) {
      const unit = group.pace === "km" ? 1000 : 100;
      const paces = sessions
        .filter((activity) => activity.distanceM > 0)
        .map((activity) => activity.movingTimeS / (activity.distanceM / unit));
      if (paces.length) parts.push(`обычный темп ${paceText(quantile(paces, 0.5), group.pace)}`);
    } else {
      const watts = sessions
        .map((activity) => activityWatts(activity))
        .filter((value): value is number => value !== null);
      if (watts.length) parts.push(`обычная мощность ~${Math.round(quantile(watts, 0.5))} Вт`);
    }
    lines.push(`- ${parts.join(", ")}`);
  }
  if (params.restingHr.length) {
    lines.push(
      `- Пульс покоя по часам за 2 недели: ${Math.min(...params.restingHr)}–${Math.max(...params.restingHr)}, обычно ~${Math.round(quantile(params.restingHr, 0.5))}`,
    );
  }
  for (const sport of params.intervals?.sports ?? []) {
    const facts = [
      sport.lthr ? `пороговый пульс ${sport.lthr}` : null,
      sport.maxHr ? `максимальный ${sport.maxHr}` : null,
      sport.ftp ? `FTP ${sport.ftp} Вт` : null,
      sport.hrZones.length ? `границы зон пульса ${sport.hrZones.join("/")}` : null,
    ].filter(Boolean);
    lines.push(`- Настройки Intervals.icu (${sport.types.join(", ")}): ${facts.join(", ")}`);
  }
  return [
    "## Её нормы (по её собственным тренировкам за 2 месяца; пульс и темп оценивай относительно них, а не по общим формулам)",
    lines.length ? lines.join("\n") : "Пока мало данных, чтобы судить о её нормах.",
  ].join("\n");
}
