import { describe, expect, it } from "vitest";

import {
  formatActivityCard,
  formatWeekSummary,
  mapStravaActivity,
  selectActivitiesToAnnounce,
} from "@/domain/stravaActivity";

const run = mapStravaActivity({
  id: 12345678901,
  name: "Утренняя пробежка",
  sport_type: "Run",
  start_date: "2026-10-15T04:30:00Z",
  timezone: "(GMT+03:00) Europe/Moscow",
  distance: 10234.6,
  moving_time: 3130,
  elapsed_time: 3300,
  total_elevation_gain: 85.4,
  average_heartrate: 148.3,
  max_heartrate: 171,
})!;

describe("V3.1.0 Strava activities", () => {
  it("maps the Strava payload into a stored row", () => {
    expect(run).toEqual(
      expect.objectContaining({
        stravaId: 12345678901n,
        name: "Утренняя пробежка",
        sportType: "Run",
        startAt: new Date("2026-10-15T04:30:00Z"),
        timezone: "Europe/Moscow",
        distanceM: 10235,
        movingTimeS: 3130,
        elevationGainM: 85,
        averageHeartrate: 148,
        maxHeartrate: 171,
        calories: null,
      }),
    );
    expect(mapStravaActivity({ name: "без id" })).toBeNull();
  });

  it("formats a run card with pace and heart rate", () => {
    expect(formatActivityCard(run)).toBe(
      [
        "🏃 Бег — «Утренняя пробежка»",
        "10,2 км · 52:10 · 5:06 /км",
        "Пульс 148 (макс 171) · Набор 85 м",
      ].join("\n"),
    );
  });

  it("formats a ride with speed and a strength session without distance", () => {
    const ride = mapStravaActivity({
      id: 2,
      name: "Вечерний вело",
      sport_type: "Ride",
      start_date: "2026-10-14T16:00:00Z",
      distance: 30000,
      moving_time: 3600,
    })!;
    const gym = mapStravaActivity({
      id: 3,
      name: "Зал",
      sport_type: "WeightTraining",
      start_date: "2026-10-13T16:00:00Z",
      moving_time: 3600,
    })!;

    expect(formatActivityCard(ride)).toBe(
      "🚴 Велосипед — «Вечерний вело»\n30,0 км · 1:00:00 · 30,0 км/ч",
    );
    expect(formatActivityCard(gym)).toBe("🏋️ Силовая — «Зал»\n1:00:00");

    expect(
      formatWeekSummary({
        activities: [run, ride, gym],
        timezone: "Europe/Moscow",
        now: new Date("2026-10-15T15:00:00Z"),
      }),
    ).toBe(
      [
        "📊 Тренировки за 7 дней (08.10–15.10)",
        "Всего: 3 · 2 ч 52 мин · 40,2 км",
        "• Велосипед: 1 · 30,0 км · 1 ч",
        "• Силовая: 1 · 1 ч",
        "• Бег: 1 · 10,2 км · 52 мин",
        "",
        "Последние:",
        "• 15.10 Бег 10,2 км · 52:10",
        "• 14.10 Велосипед 30,0 км · 1:00:00",
        "• 13.10 Силовая 1:00:00",
      ].join("\n"),
    );
  });

  it("announces only fresh, not yet announced workouts", () => {
    const now = new Date("2026-10-15T15:00:00Z");
    const fresh = { startAt: new Date("2026-10-15T04:30:00Z"), notifiedAt: null };
    const old = { startAt: new Date("2026-10-01T04:30:00Z"), notifiedAt: null };
    const done = { startAt: new Date("2026-10-15T05:30:00Z"), notifiedAt: now };

    expect(selectActivitiesToAnnounce([fresh, old, done], now)).toEqual([fresh]);
  });
});
