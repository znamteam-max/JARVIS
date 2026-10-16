import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  createManualPlannerItem: vi.fn(),
  createScheduledItemFromIntent: vi.fn(),
  createReminderPolicyIfMissing: vi.fn(),
  materializeNextPolicyReminder: vi.fn(),
  applyItemEditMutation: vi.fn(),
  writeAudit: vi.fn(),
  upsertFitnessActivities: vi.fn(),
  listWellnessDaysSince: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({ createManualPlannerItem: calls.createManualPlannerItem }));
vi.mock("@/services/scheduledCreationIntentService", () => ({
  createScheduledItemFromIntent: calls.createScheduledItemFromIntent,
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  createReminderPolicyIfMissing: calls.createReminderPolicyIfMissing,
}));
vi.mock("@/services/reminderPolicyEngine", () => ({
  materializeNextPolicyReminder: calls.materializeNextPolicyReminder,
}));
vi.mock("@/services/itemEditMutations", async (original) => ({
  ...(await original<typeof import("@/services/itemEditMutations")>()),
  applyItemEditMutation: calls.applyItemEditMutation,
}));
vi.mock("@/db/queries/audit", () => ({ writeAudit: calls.writeAudit }));
vi.mock("@/db/queries/fitness", () => ({
  upsertFitnessActivities: calls.upsertFitnessActivities,
  listWellnessDaysSince: calls.listWellnessDaysSince,
}));

import {
  createPlannerItemFromApp,
  estimateWorkoutCalories,
  logManualWorkout,
} from "@/services/miniappCreate";
import type { User } from "@/db/schema";

const USER = { id: "u1", timezone: "Europe/Moscow" } as User;
const NOW = new Date("2026-10-16T09:00:00Z"); // 12:00 Moscow

function fakeItem(overrides: Record<string, unknown>) {
  return {
    id: "item-1",
    userId: "u1",
    title: "Оплатить кружок",
    kind: "task",
    timezone: "Europe/Moscow",
    category: null,
    startAt: null,
    endAt: null,
    dueAt: null,
    metadata: {},
    ...overrides,
  };
}

describe("adding to the schedule from the app", () => {
  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockReset();
    calls.writeAudit.mockResolvedValue(undefined);
    calls.createReminderPolicyIfMissing.mockImplementation(async (policy) => ({
      id: "p",
      ...policy,
    }));
    calls.materializeNextPolicyReminder.mockResolvedValue({ id: "r" });
  });

  it("a task on the 21st at 10:00 reminds exactly then", async () => {
    calls.createManualPlannerItem.mockImplementation(async (params) => fakeItem(params));
    await createPlannerItemFromApp({
      user: USER,
      kind: "task",
      title: "Оплатить кружок",
      dateLocal: "2026-10-21",
      timeLocal: "10:00",
      durationMinutes: 60,
      reminders: ["at_time"],
      now: NOW,
    });
    expect(calls.createManualPlannerItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "task", dueAt: new Date("2026-10-21T07:00:00Z") }),
    );
    expect(calls.createReminderPolicyIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        policyType: "one_time",
        nextFireAt: new Date("2026-10-21T07:00:00Z"),
      }),
    );
  });

  it("a date without a time is a deadline at 23:59 and sets no reminder", async () => {
    calls.createManualPlannerItem.mockImplementation(async (params) => fakeItem(params));
    await createPlannerItemFromApp({
      user: USER,
      kind: "task",
      title: "Сдать отчёт",
      dateLocal: "2026-10-21",
      timeLocal: null,
      durationMinutes: 60,
      reminders: [],
      now: NOW,
    });
    expect(calls.createManualPlannerItem).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: new Date("2026-10-21T20:59:00Z") }),
    );
    expect(calls.createReminderPolicyIfMissing).not.toHaveBeenCalled();
  });

  it("a meeting becomes an event with an hour-before reminder", async () => {
    calls.createScheduledItemFromIntent.mockResolvedValue({
      item: fakeItem({ kind: "event", startAt: new Date("2026-10-21T12:00:00Z") }),
    });
    await createPlannerItemFromApp({
      user: USER,
      kind: "event",
      title: "Стоматолог",
      dateLocal: "2026-10-21",
      timeLocal: "15:00",
      durationMinutes: 90,
      reminders: ["1h"],
      now: NOW,
    });
    const intent = calls.createScheduledItemFromIntent.mock.calls[0][0].intent;
    expect(intent).toMatchObject({
      kind: "event",
      startLocal: "2026-10-21T15:00:00",
      endLocal: "2026-10-21T16:30:00",
    });
    expect(intent.reminders).toEqual([
      { fireAtLocal: "2026-10-21T14:00:00", minutesBefore: 60, label: "за час" },
    ]);
  });

  it("a meeting needs a time", async () => {
    await expect(
      createPlannerItemFromApp({
        user: USER,
        kind: "event",
        title: "Встреча",
        dateLocal: "2026-10-21",
        timeLocal: null,
        durationMinutes: 60,
        reminders: [],
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "time_required" });
  });

  it("reminders already in the past are skipped", async () => {
    calls.createManualPlannerItem.mockImplementation(async (params) => fakeItem(params));
    await createPlannerItemFromApp({
      user: USER,
      kind: "task",
      title: "Позвонить",
      dateLocal: "2026-10-16",
      timeLocal: "12:30",
      durationMinutes: 60,
      reminders: ["at_time", "1h"],
      now: NOW,
    });
    expect(calls.createReminderPolicyIfMissing).toHaveBeenCalledTimes(1);
  });
});

describe("adding a workout by hand", () => {
  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockReset();
    calls.upsertFitnessActivities.mockResolvedValue([]);
  });

  it("estimates calories from the sport, time and the latest weight", async () => {
    expect(estimateWorkoutCalories({ sportType: "Run", durationMinutes: 30, weightKg: 80 })).toBe(
      392,
    );
    calls.listWellnessDaysSince.mockResolvedValue([{ raw: { weight: 82 } }]);
    const logged = await logManualWorkout({
      user: USER,
      sportType: "WeightTraining",
      startLocal: "2026-10-16T19:00",
      durationMinutes: 60,
      calories: null,
      distanceKm: null,
    });
    expect(logged).toMatchObject({ calories: 410, estimated: true, label: "Силовая" });
    const [, source, rows] = calls.upsertFitnessActivities.mock.calls[0];
    expect(source).toBe("manual");
    expect(rows[0]).toMatchObject({ movingTimeS: 3600, startAt: new Date("2026-10-16T16:00:00Z") });
  });

  it("keeps calories the user typed", async () => {
    const logged = await logManualWorkout({
      user: USER,
      sportType: "Run",
      startLocal: "2026-10-16T08:00",
      durationMinutes: 40,
      calories: 450,
      distanceKm: 7.5,
    });
    expect(logged).toMatchObject({ calories: 450, estimated: false });
    expect(calls.upsertFitnessActivities.mock.calls[0][2][0].distanceM).toBe(7500);
    expect(calls.listWellnessDaysSince).not.toHaveBeenCalled();
  });
});
