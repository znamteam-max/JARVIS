import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";

import { writeAudit } from "@/db/queries/audit";
import { listWellnessDaysSince, upsertFitnessActivities } from "@/db/queries/fitness";
import { createManualPlannerItem } from "@/db/queries/items";
import { createReminderPolicyIfMissing } from "@/db/queries/reminderPolicies";
import type { PlannerItem, User } from "@/db/schema";
import { localIsoToDate } from "@/domain/scheduledCreationIntent";
import { sportLabel } from "@/domain/stravaActivity";
import {
  applyItemEditMutation,
  parseItemEditMutation,
  type ItemEditMutation,
} from "@/services/itemEditMutations";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";
import { createScheduledItemFromIntent } from "@/services/scheduledCreationIntentService";

export const MANUAL_WORKOUT_SOURCE = "manual";

// Quick reminder choices in the "Добавить" form, in minutes before the time.
export const REMINDER_CHOICES = {
  at_time: { minutes: 0, label: "в это время" },
  "15m": { minutes: 15, label: "за 15 минут" },
  "1h": { minutes: 60, label: "за час" },
  "2h": { minutes: 120, label: "за 2 часа" },
  "1d": { minutes: 1440, label: "за день" },
} as const;
export type ReminderChoice = keyof typeof REMINDER_CHOICES;

export class AppCreateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// The Mini App's "Добавить в расписание": a form instead of a sentence, so it works
// without Telegram and without AI guessing. Same storage as the bot's own creations.
export async function createPlannerItemFromApp(params: {
  user: User;
  kind: "task" | "event" | "training";
  title: string;
  dateLocal: string | null;
  timeLocal: string | null;
  durationMinutes: number;
  reminders: ReminderChoice[];
  remindersText?: string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const timezone = params.user.timezone;
  const isEvent = params.kind !== "task";
  if (isEvent && (!params.dateLocal || !params.timeLocal))
    throw new AppCreateError("time_required");

  // A date without a time is a deadline at the end of that day, like "дедлайн 23.59".
  const anchorLocal = params.dateLocal
    ? DateTime.fromISO(`${params.dateLocal}T${params.timeLocal ?? "23:59"}`, { zone: timezone })
    : null;
  if (anchorLocal && !anchorLocal.isValid) throw new AppCreateError("invalid_time");

  let item: PlannerItem;
  if (isEvent && anchorLocal) {
    const end = anchorLocal.plus({ minutes: params.durationMinutes });
    const created = await createScheduledItemFromIntent({
      userId: params.user.id,
      now,
      intent: {
        intent: "scheduled_creation",
        kind: params.kind === "training" ? "training" : "event",
        title: params.title,
        timezone,
        startLocal: anchorLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        endLocal: end.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        reminders: params.reminders
          .map((choice) => REMINDER_CHOICES[choice])
          .filter((choice) => choice.minutes > 0)
          .map((choice) => ({
            fireAtLocal: anchorLocal
              .minus({ minutes: choice.minutes })
              .toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            minutesBefore: choice.minutes,
            label: choice.label,
          }))
          .filter((spec) => localIsoToDate(spec.fireAtLocal, timezone) > now),
        remindersSuppressedByUser: false,
        warnings: [],
      },
    });
    item = created.item;
    if (params.reminders.includes("at_time") && anchorLocal.toJSDate() > now) {
      await addOneTimeReminder(item, anchorLocal.toJSDate(), "в начале");
    }
  } else {
    item = await createManualPlannerItem({
      userId: params.user.id,
      kind: "task",
      title: params.title,
      timezone,
      dueAt: anchorLocal?.toUTC().toJSDate() ?? null,
      metadata: { sourceNormalization: "miniapp_create" },
    });
    if (anchorLocal) {
      for (const choice of params.reminders) {
        const { minutes, label } = REMINDER_CHOICES[choice];
        const fireAt = anchorLocal.minus({ minutes }).toUTC().toJSDate();
        if (fireAt > now) await addOneTimeReminder(item, fireAt, label, minutes);
      }
    }
  }

  // Anything richer ("каждый час с 8 до 12") goes through the bot's own edit parser.
  let extraUnderstood: boolean | null = null;
  if (params.remindersText?.trim()) {
    const parsed = parseItemEditMutation({
      text: params.remindersText,
      item,
      timezone,
      now,
    }).reminderPolicy;
    extraUnderstood = Boolean(parsed);
    if (parsed) {
      const mutation: ItemEditMutation = {
        itemId: item.id,
        reminderPolicy:
          parsed.policyType === "before_event_multi" && parsed.mode === "ask"
            ? { ...parsed, mode: "add" }
            : parsed,
        changedFields: ["reminder_policy"],
        warnings: [],
        pastConfirmationRequired: false,
      };
      await applyItemEditMutation({ userId: params.user.id, item, mutation, timezone });
    }
  }

  await writeAudit({
    userId: params.user.id,
    action: "assistant.planner_mutation",
    entityType: "planner_item",
    entityId: item.id,
    details: {
      mutationSource: "miniapp_create",
      operation: "create",
      kind: item.kind,
      reminders: params.reminders,
      extraReminderUnderstood: extraUnderstood,
    },
  }).catch(() => undefined);
  return { item, extraUnderstood };
}

// "Напомни в 11:00 и в 17:00": one reminder at an exact local time ("yyyy-MM-ddTHH:mm"),
// skipped when that moment has already passed.
export async function addReminderAtLocal(item: PlannerItem, local: string, now = new Date()) {
  const fireAt = DateTime.fromISO(local, { zone: item.timezone });
  if (!fireAt.isValid || fireAt.toJSDate() <= now) return false;
  await addOneTimeReminder(item, fireAt.toUTC().toJSDate(), "в это время");
  return true;
}

async function addOneTimeReminder(item: PlannerItem, fireAt: Date, label: string, minutes = 0) {
  const policy = await createReminderPolicyIfMissing({
    userId: item.userId,
    itemId: item.id,
    title: item.title,
    category: minutes > 0 ? "pre_event" : (item.category ?? "today_focus"),
    policyType: minutes > 0 ? "before_event" : "one_time",
    timezone: item.timezone,
    startsAt: fireAt,
    nextFireAt: fireAt,
    requireAck: false,
    catchUpMode: "one_immediate_then_resume",
    idempotencyKey: `miniapp-create:${item.id}:${minutes}:${fireAt.toISOString()}`,
    metadata: {
      mutationSource: "miniapp_create",
      ...(minutes > 0 ? { minutesBefore: minutes, relativeLabel: label } : {}),
    },
  });
  await materializeNextPolicyReminder(policy, fireAt);
}

// Rough MET values, used only when the calories are left empty.
const MET: Record<string, number> = {
  Run: 9.8,
  Ride: 7.5,
  VirtualRide: 7,
  WeightTraining: 5,
  Walk: 3.5,
  Swim: 7,
  Yoga: 3,
  Workout: 6,
};
const DEFAULT_WEIGHT_KG = 75;

export function estimateWorkoutCalories(params: {
  sportType: string;
  durationMinutes: number;
  weightKg: number;
}) {
  const met = MET[params.sportType] ?? MET.Workout;
  return Math.round(met * params.weightKg * (params.durationMinutes / 60));
}

// "Добавить тренировку": for sessions the watch did not record.
export async function logManualWorkout(params: {
  user: User;
  sportType: string;
  startLocal: string;
  durationMinutes: number;
  calories: number | null;
  distanceKm: number | null;
}) {
  const start = DateTime.fromISO(params.startLocal, { zone: params.user.timezone });
  if (!start.isValid) throw new AppCreateError("invalid_time");
  let calories = params.calories;
  let estimated = false;
  if (calories === null) {
    const recent = await listWellnessDaysSince(
      params.user.id,
      start.minus({ days: 30 }).toISODate() ?? "",
    );
    const weight = recent
      .map((day) => Number((day.raw as Record<string, unknown>)?.weight))
      .find((value) => Number.isFinite(value) && value > 30);
    calories = estimateWorkoutCalories({
      sportType: params.sportType,
      durationMinutes: params.durationMinutes,
      weightKg: weight ?? DEFAULT_WEIGHT_KG,
    });
    estimated = true;
  }
  const seconds = Math.round(params.durationMinutes * 60);
  await upsertFitnessActivities(params.user.id, MANUAL_WORKOUT_SOURCE, [
    {
      externalId: randomUUID(),
      name: sportLabel(params.sportType),
      sportType: params.sportType,
      startAt: start.toUTC().toJSDate(),
      distanceM: Math.round((params.distanceKm ?? 0) * 1000),
      movingTimeS: seconds,
      elapsedTimeS: seconds,
      elevationGainM: 0,
      averageHeartrate: null,
      maxHeartrate: null,
      calories,
      trainingLoad: null,
      raw: { source: MANUAL_WORKOUT_SOURCE, caloriesEstimated: estimated },
    },
  ]);
  return { calories, estimated, label: sportLabel(params.sportType) };
}
