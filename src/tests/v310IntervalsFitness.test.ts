import { describe, expect, it } from "vitest";

import {
  formatWellnessSummary,
  mapIntervalsActivity,
  mapIntervalsWellness,
} from "@/domain/intervalsFitness";
import { formatActivityCard } from "@/domain/stravaActivity";

describe("V3.1.0 Intervals.icu fitness data", () => {
  it("maps a Garmin activity from Intervals and reuses the activity card", () => {
    const run = mapIntervalsActivity(
      {
        id: "i98765432",
        source: "GARMIN_CONNECT",
        type: "Run",
        name: "Москва Бег",
        start_date_local: "2026-10-15T07:30:00",
        distance: 8012.4,
        moving_time: 2580,
        elapsed_time: 2650,
        total_elevation_gain: 40.2,
        average_heartrate: 151.6,
        max_heartrate: 176,
        calories: 612,
        icu_training_load: 63.4,
      },
      "Europe/Moscow",
    );

    expect(run).toEqual(
      expect.objectContaining({
        externalId: "i98765432",
        sportType: "Run",
        startAt: new Date("2026-10-15T04:30:00.000Z"),
        distanceM: 8012,
        averageHeartrate: 152,
        calories: 612,
        trainingLoad: 63,
      }),
    );
    expect(formatActivityCard(run!)).toBe(
      [
        "🏃 Бег — «Москва Бег»",
        "8,0 км · 43:00 · 5:22 /км",
        "Пульс 152 (макс 176) · Набор 40 м",
      ].join("\n"),
    );
  });

  it("skips Strava stubs that Intervals is not allowed to forward", () => {
    expect(
      mapIntervalsActivity(
        { id: "12345", source: "STRAVA", start_date_local: "2026-10-15T07:30:00" },
        "Europe/Moscow",
      ),
    ).toBeNull();
  });

  it("keeps wellness days with data and summarises the last night and the week", () => {
    const days = [
      { id: "2026-10-15", sleepSecs: 26100, sleepScore: 82, hrv: 54.4, restingHR: 52, steps: 3120 },
      { id: "2026-10-14", sleepSecs: 23400, hrv: 48, restingHR: 55 },
      { id: "2026-10-13" },
    ]
      .map(mapIntervalsWellness)
      .filter((day) => day !== null);

    expect(days.map((day) => day.day)).toEqual(["2026-10-15", "2026-10-14"]);
    expect(formatWellnessSummary(days)).toBe(
      [
        "😴 Сон и восстановление (15.10)",
        "Сон 7 ч 15 мин, оценка 82",
        "HRV 54 · пульс покоя 52 · шаги 3120",
        "В среднем за 2 дн.: сон 6 ч 53 мин · HRV 51 · пульс покоя 54",
      ].join("\n"),
    );
  });
});
