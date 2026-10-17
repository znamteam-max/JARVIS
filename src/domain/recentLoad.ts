import { DateTime } from "luxon";

import { activityWatts } from "@/domain/activityDedupe";

type LoadActivity = {
  startAt: Date;
  movingTimeS: number;
  elapsedTimeS: number;
  trainingLoad?: number | null;
  raw: unknown;
};

export type TrainingSession = {
  start: Date;
  end: Date;
  minutes: number;
  parts: number[];
  watts: number | null;
  load: number | null;
};

// Two Zwift workouts with an 8-minute break are one training for the body: the coach
// once read "36 мин" and "85 мин" as two short days and planned another long ride.
export const SESSION_GAP_MINUTES = 30;

function activityLoad(activity: LoadActivity) {
  const raw = (activity.raw ?? {}) as Record<string, unknown>;
  const load = Number(raw.icu_training_load ?? activity.trainingLoad);
  return Number.isFinite(load) && load > 0 ? load : null;
}

export function groupTrainingSessions(
  activities: LoadActivity[],
  gapMinutes = SESSION_GAP_MINUTES,
): TrainingSession[] {
  const sorted = [...activities].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const sessions: Array<{ start: number; end: number; items: LoadActivity[] }> = [];
  for (const activity of sorted) {
    const start = activity.startAt.getTime();
    const end = start + Math.max(activity.elapsedTimeS, activity.movingTimeS) * 1000;
    const last = sessions.at(-1);
    if (last && start - last.end <= gapMinutes * 60_000) {
      last.end = Math.max(last.end, end);
      last.items.push(activity);
    } else {
      sessions.push({ start, end, items: [activity] });
    }
  }
  return sessions.map(({ start, end, items }) => {
    const parts = items.map((item) => Math.round(item.movingTimeS / 60));
    const powered = items.filter((item) => activityWatts(item) !== null);
    const poweredSeconds = powered.reduce((sum, item) => sum + item.movingTimeS, 0);
    const watts = poweredSeconds
      ? Math.round(
          powered.reduce((sum, item) => sum + activityWatts(item)! * item.movingTimeS, 0) /
            poweredSeconds,
        )
      : null;
    const loads = items.map(activityLoad).filter((load): load is number => load !== null);
    return {
      start: new Date(start),
      end: new Date(end),
      minutes: parts.reduce((sum, value) => sum + value, 0),
      parts,
      watts,
      load: loads.length ? Math.round(loads.reduce((sum, value) => sum + value, 0)) : null,
    };
  });
}

function duration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} ч${rest ? ` ${rest} мин` : ""}` : `${rest} мин`;
}

function ago(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} ч`;
  return `${Math.round(minutes / (24 * 60))} дн`;
}

function describeSession(session: TrainingSession) {
  return [
    session.parts.length > 1
      ? `${session.minutes} мин (${session.parts.join(" + ")}, одна тренировка)`
      : `${session.minutes} мин`,
    session.watts ? `~${session.watts} Вт` : null,
    session.load ? `нагрузка ${session.load}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

// "What did the last days look like" in a few lines, read before any advice for today.
export function recentLoadBlock(params: {
  activities: LoadActivity[];
  now: Date;
  timezone: string;
  days?: number;
}) {
  const days = params.days ?? 7;
  const today = DateTime.fromJSDate(params.now, { zone: "utc" })
    .setZone(params.timezone)
    .startOf("day");
  const at = (date: Date) =>
    DateTime.fromJSDate(date, { zone: "utc" }).setZone(params.timezone).setLocale("ru");
  const sessions = groupTrainingSessions(params.activities).filter(
    (session) => session.start <= params.now,
  );
  const header = `## Нагрузка последних дней (заезды с перерывом до ${SESSION_GAP_MINUTES} мин — одна тренировка)`;
  const last = sessions.at(-1);
  if (!last) return `${header}\nТренировок за последние недели нет.`;

  const lines = [
    `Последняя тренировка закончилась ${ago(params.now.getTime() - last.end.getTime())} назад (${at(last.start).toFormat("ccc dd.LL HH:mm")}–${at(last.end).toFormat("HH:mm")}): ${describeSession(last)}.`,
    "По дням:",
  ];
  let count = 0;
  let totalMinutes = 0;
  let totalLoad = 0;
  for (let index = 0; index < days; index += 1) {
    const day = today.minus({ days: index });
    const daySessions = sessions.filter((session) => at(session.start).hasSame(day, "day"));
    count += daySessions.length;
    for (const session of daySessions) {
      totalMinutes += session.minutes;
      totalLoad += session.load ?? 0;
    }
    const label = `${day.setLocale("ru").toFormat("ccc dd.LL")}${index === 0 ? " (сегодня)" : ""}`;
    lines.push(
      `- ${label}: ${daySessions.length ? daySessions.map(describeSession).join("; ") : "без тренировок"}`,
    );
  }
  lines.push(
    `За ${days} дней: ${count} трен., ${duration(totalMinutes)}${totalLoad ? `, нагрузка ${totalLoad}` : ""}.`,
  );
  return [header, ...lines].join("\n");
}
