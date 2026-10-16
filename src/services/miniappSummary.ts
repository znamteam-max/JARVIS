import { DateTime } from "luxon";

import { listFitnessActivitiesSince, listWellnessDaysSince } from "@/db/queries/fitness";
import { getNutritionGoals, listFoodEntriesSince } from "@/db/queries/food";
import type { FoodEntry, User } from "@/db/schema";
import { sumFoodMacros } from "@/domain/foodEstimate";
import { signFoodPhotoUrl } from "@/domain/foodPhoto";
import { formatWellnessSummary } from "@/domain/intervalsFitness";
import { computeCalorieBudget, parsePlanSections } from "@/domain/miniapp";
import { formatActivityCard } from "@/domain/stravaActivity";
import { getEnv } from "@/lib/env";
import { renderLiveDashboard } from "@/telegram/liveDashboard";

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export type MiniAppSummary = Awaited<ReturnType<typeof buildMiniAppSummary>>;

// One payload for the whole Mini App: every tab renders from it, every mutation returns it.
export async function buildMiniAppSummary(user: User, now = new Date()) {
  const timezone = user.timezone;
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone).setLocale("ru");
  const today = local.toISODate() ?? "";
  const weekStart = local.startOf("week");
  const since = DateTime.min(weekStart, local.startOf("day").minus({ days: 6 }));

  const [goals, foodSince, plan, activities, wellness] = await Promise.all([
    getNutritionGoals(user.id),
    listFoodEntriesSince({ userId: user.id, since: since.toUTC().toJSDate() }),
    renderLiveDashboard({ userId: user.id, timezone, now, readOnly: true }),
    listFitnessActivitiesSince(user.id, since.toUTC().toJSDate()),
    listWellnessDaysSince(user.id, local.minus({ days: 7 }).toISODate() ?? ""),
  ]);

  const dayOf = (date: Date) =>
    DateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone).toISODate() ?? "";
  // Newest additions first, so what was just logged is always on top.
  const todayFood = foodSince
    .filter((entry) => dayOf(entry.eatenAt) === today)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const todayWorkouts = activities.filter((activity) => dayOf(activity.startAt) === today);
  const workoutCalories = todayWorkouts.reduce((sum, a) => sum + (a.calories ?? 0), 0);
  const eaten = sumFoodMacros(todayFood);

  const week = WEEKDAYS.map((label, index) => {
    const date = weekStart.plus({ days: index }).toISODate() ?? "";
    const calories = foodSince
      .filter((entry) => dayOf(entry.eatenAt) === date)
      .reduce((sum, entry) => sum + entry.calories, 0);
    return { label, date, calories, isToday: date === today, isFuture: date > today };
  });
  const loggedDays = week.filter((day) => !day.isFuture && day.calories > 0);
  const photoSecret = getEnv().MEDIA_WORKER_TOKEN;
  const photoUrl = (entry: FoodEntry) =>
    entry.photoKey && photoSecret
      ? signFoodPhotoUrl({ entryId: entry.id, secret: photoSecret, now })
      : null;
  const weekActivities = activities.filter((a) => a.startAt >= weekStart.toUTC().toJSDate());

  return {
    dateLabel: local.toFormat("cccc, d MMMM"),
    goals,
    eaten,
    workoutCalories,
    budget: computeCalorieBudget({ goals, eaten, workoutCalories }),
    plan: withEditableItems(plan, timezone),
    food: {
      today: todayFood.map((entry) => ({
        ...foodView(entry, timezone),
        photoUrl: photoUrl(entry),
      })),
      // Newest first: every stored photo of the last 7+ days, so any of them can be removed.
      photos: foodSince
        .filter((entry) => entry.photoKey)
        .reverse()
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          calories: entry.calories,
          label: DateTime.fromJSDate(entry.eatenAt, { zone: "utc" })
            .setZone(timezone)
            .setLocale("ru")
            .toFormat("ccc HH:mm"),
          url: photoUrl(entry) ?? "",
        })),
      week,
      averageCalories: loggedDays.length
        ? Math.round(loggedDays.reduce((sum, day) => sum + day.calories, 0) / loggedDays.length)
        : 0,
      daysInTarget: loggedDays.filter(
        (day) => Math.abs(day.calories - goals.calories) <= goals.calories * 0.05,
      ).length,
      loggedDays: loggedDays.length,
    },
    fitness: {
      count: weekActivities.length,
      movingTimeS: weekActivities.reduce((sum, a) => sum + a.movingTimeS, 0),
      distanceM: weekActivities.reduce((sum, a) => sum + a.distanceM, 0),
      calories: weekActivities.reduce((sum, a) => sum + (a.calories ?? 0), 0),
      activities: activities.map((activity) => {
        const [title = "", metrics = "", extra = ""] = formatActivityCard(activity).split("\n");
        return {
          id: activity.id,
          manual: activity.source === "manual",
          day: WEEKDAYS[DateTime.fromJSDate(activity.startAt).setZone(timezone).weekday - 1],
          title,
          metrics,
          extra,
        };
      }),
      wellnessText: formatWellnessSummary(
        wellness.map((day) => ({ ...day, raw: day.raw as Record<string, unknown> })),
      ),
      latestWellness: wellness[0]
        ? {
            day: wellness[0].day,
            sleepSecs: wellness[0].sleepSecs,
            sleepScore: wellness[0].sleepScore,
            hrv: wellness[0].hrv,
            restingHr: wellness[0].restingHr,
          }
        : null,
    },
  };
}

// Each plan row carries its item's editable fields; external calendar rows stay read-only.
function withEditableItems(
  plan: Awaited<ReturnType<typeof renderLiveDashboard>>,
  timezone: string,
) {
  const refs = ("refs" in plan ? plan.refs : undefined) ?? [];
  const items = new Map(plan.items.map((item) => [item.id, item]));
  const local = (date: Date | null) =>
    date
      ? DateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm")
      : null;
  return parsePlanSections(plan.text).map((section) => ({
    ...section,
    rows: section.rows.map((row) => {
      const ref = refs[row.number - 1];
      const item = ref?.type === "planner_item" ? items.get(ref.id) : undefined;
      return {
        ...row,
        item: item
          ? {
              id: item.id,
              title: item.title,
              kind: item.kind,
              startLocal: local(item.startAt),
              endLocal: local(item.endAt),
              dueLocal: local(item.dueAt),
            }
          : null,
      };
    }),
  }));
}

function foodView(entry: FoodEntry, timezone: string) {
  return {
    id: entry.id,
    title: entry.title,
    time: DateTime.fromJSDate(entry.eatenAt, { zone: "utc" }).setZone(timezone).toFormat("HH:mm"),
    eatenAtLocal: DateTime.fromJSDate(entry.eatenAt, { zone: "utc" })
      .setZone(timezone)
      .toFormat("yyyy-MM-dd'T'HH:mm"),
    calories: entry.calories,
    proteinG: entry.proteinG,
    fatG: entry.fatG,
    carbsG: entry.carbsG,
    confidence: entry.confidence,
    items: (entry.items as Array<Record<string, unknown>>).map((item) => ({
      name: String(item.name ?? ""),
      grams: typeof item.grams === "number" ? item.grams : null,
      calories: Number(item.calories ?? 0),
      proteinG: Number(item.proteinG ?? 0),
      fatG: Number(item.fatG ?? 0),
      carbsG: Number(item.carbsG ?? 0),
    })),
  };
}
