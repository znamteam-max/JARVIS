import { describe, expect, it } from "vitest";

import {
  activityWatts,
  coachNotificationExcerpt,
  withoutWatchDuplicates,
} from "@/domain/activityDedupe";
import { analyseRide, samplesFromStreams } from "@/domain/rideAnalysis";

const at = (iso: string) => new Date(iso);

// Yesterday's real shape: the watch recorded 2:10, Zwift recorded two rides inside it.
const garmin = {
  name: "watch",
  startAt: at("2026-10-16T18:49:13Z"),
  elapsedTimeS: 7832,
  movingTimeS: 7832,
  raw: { source: "GARMIN_CONNECT" },
  calories: 1536,
};
const zwiftEasy45 = {
  name: "zwift 45",
  startAt: at("2026-10-16T18:49:38Z"),
  elapsedTimeS: 2157,
  movingTimeS: 2157,
  raw: { source: "ZWIFT", icu_average_watts: 178 },
  calories: 367,
};
const zwiftHour = {
  name: "zwift hour",
  startAt: at("2026-10-16T19:33:35Z"),
  elapsedTimeS: 5122,
  movingTimeS: 5120,
  raw: { source: "ZWIFT", icu_average_watts: 194 },
  calories: 947,
};

describe("one indoor ride, recorded twice", () => {
  it("drops the watch's copy of two Zwift rides", () => {
    const kept = withoutWatchDuplicates([garmin, zwiftEasy45, zwiftHour]);
    expect(kept.map((activity) => activity.name)).toEqual(["zwift 45", "zwift hour"]);
    expect(kept.reduce((sum, activity) => sum + activity.calories, 0)).toBe(1314);
  });

  it("keeps watch-only workouts (strength, a ride without Zwift)", () => {
    const strength = {
      name: "strength",
      startAt: at("2026-10-16T08:00:00Z"),
      elapsedTimeS: 1800,
      movingTimeS: 1800,
      raw: {},
      calories: 150,
    };
    expect(withoutWatchDuplicates([strength, zwiftHour]).map((a) => a.name)).toEqual([
      "strength",
      "zwift hour",
    ]);
    expect(withoutWatchDuplicates([garmin]).map((a) => a.name)).toEqual(["watch"]);
  });

  it("reads power only from Intervals' average watts", () => {
    expect(activityWatts(zwiftHour)).toBe(194);
    expect(activityWatts(garmin)).toBeNull();
    expect(activityWatts({ raw: { icu_average_watts: 0 } })).toBeNull();
  });
});

describe("coach review plumbing", () => {
  it("turns Intervals streams into the same ride analysis as a FIT file", () => {
    const seconds = Array.from({ length: 3600 }, (_, i) => i);
    const summary = analyseRide(
      samplesFromStreams(at("2026-10-16T19:33:35Z"), [
        { type: "time", data: seconds },
        { type: "watts", data: seconds.map(() => 195) },
        { type: "heartrate", data: seconds.map((i) => (i < 1800 ? 135 : 141)) },
        { type: "cadence", data: seconds.map(() => 88) },
      ]),
      { ftp: 300 },
    );
    expect(summary?.np).toBe(195);
    expect(summary?.startedAt).toBe("2026-10-16T19:33:35.000Z");
    expect(summary?.decouplingPct).toBeGreaterThan(3);
  });

  it("the notification keeps the opening, without tables and Markdown", () => {
    const review = [
      "**2 часа Z2 закрыты ровно: 194 Вт при пульсе 140.**",
      "",
      "| Отрезок | Вт | Пульс |",
      "|---|---|---|",
      "| 1 | 178 | 125 |",
      "",
      "## Что дальше",
      "Завтра — отдых.",
    ].join("\n");
    const excerpt = coachNotificationExcerpt(review);
    expect(excerpt).toBe(
      "2 часа Z2 закрыты ровно: 194 Вт при пульсе 140.\n\nЧто дальше\nЗавтра — отдых.",
    );
    expect(coachNotificationExcerpt("а".repeat(2000)).length).toBeLessThanOrEqual(701);
  });
});
