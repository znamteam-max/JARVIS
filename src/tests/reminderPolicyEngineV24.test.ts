import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createReminderPolicyIfMissing: vi.fn(),
  createPolicyOccurrence: vi.fn(),
  attachOccurrenceReminder: vi.fn(),
  getPolicyForReminder: vi.fn(),
  markPolicyOccurrenceAcked: vi.fn(),
  markPolicyOccurrenceDelivered: vi.fn(),
  updateReminderPolicy: vi.fn(),
  createReminderIfMissing: vi.fn(),
  restoreReminderByIdempotencyKey: vi.fn(),
}));

vi.mock("@/db/queries/reminderPolicies", () => ({
  createReminderPolicyIfMissing: mocks.createReminderPolicyIfMissing,
  createPolicyOccurrence: mocks.createPolicyOccurrence,
  attachOccurrenceReminder: mocks.attachOccurrenceReminder,
  getPolicyForReminder: mocks.getPolicyForReminder,
  markPolicyOccurrenceAcked: mocks.markPolicyOccurrenceAcked,
  markPolicyOccurrenceDelivered: mocks.markPolicyOccurrenceDelivered,
  updateReminderPolicy: mocks.updateReminderPolicy,
}));
vi.mock("@/db/queries/reminders", () => ({
  createReminderIfMissing: mocks.createReminderIfMissing,
  restoreReminderByIdempotencyKey: mocks.restoreReminderByIdempotencyKey,
}));

import {
  advancePolicyAfterDelivery,
  applyAgentReminderPolicies,
  materializeNextPolicyReminder,
} from "@/services/reminderPolicyEngine";

describe("V2.4 reminder policy engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createReminderPolicyIfMissing.mockImplementation(async (input) => ({
      id: `policy-${input.title}`,
      status: "active",
      ...input,
    }));
    mocks.createReminderIfMissing.mockResolvedValue({ id: "reminder-id" });
    mocks.restoreReminderByIdempotencyKey.mockResolvedValue(null);
    mocks.createPolicyOccurrence.mockResolvedValue({ id: "occurrence-id" });
    mocks.updateReminderPolicy.mockImplementation(async (input) => ({
      id: input.policyId,
      userId: input.userId,
      itemId: "item-id",
      title: "Винбокс",
      category: "nag_until_done",
      policyType: "interval_window",
      status: "active",
      timezone: "Europe/Moscow",
      startsAt: new Date("2026-06-08T05:00:00.000Z"),
      endsAt: new Date("2026-06-08T08:00:00.000Z"),
      nextFireAt: input.nextFireAt,
      recurrenceRule: null,
      intervalMinutes: 30,
      requireAck: true,
      maxOccurrences: null,
      quietHours: null,
      escalationPolicy: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  });

  it("stores one interval policy and only the next occurrence", async () => {
    const result = await applyAgentReminderPolicies({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T08:00:00.000Z"),
      availableItems: [makeItem()],
      proposals: [
        {
          operation: "create_interval_window_policy",
          itemIds: ["11111111-1111-4111-8111-111111111111"],
          itemTitle: "Записать кружок с анонсом винбокса",
          title: "Записать кружок с анонсом винбокса",
          category: "nag_until_done",
          policyType: "interval_window",
          startsAtLocal: "2026-06-08T08:00:00",
          endsAtLocal: "2026-06-08T11:00:00",
          nextFireAtLocal: "2026-06-08T08:00:00",
          recurrenceRule: null,
          intervalMinutes: 30,
          requireAck: true,
          maxOccurrences: null,
          minutesBefore: null,
        },
      ],
    });

    expect(result.policies).toHaveLength(1);
    expect(mocks.createReminderPolicyIfMissing).toHaveBeenCalledTimes(1);
    expect(mocks.createReminderIfMissing).toHaveBeenCalledTimes(1);
    expect(mocks.createReminderIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: expect.stringContaining("policy-"),
        scheduledAt: new Date("2026-06-08T05:00:00.000Z"),
      }),
    );
  });

  it("advances an interval policy by one occurrence instead of prebuilding a pile", async () => {
    const policy = {
      id: "policy-id",
      userId: "user-id",
      itemId: "item-id",
      title: "Винбокс",
      category: "nag_until_done",
      policyType: "interval_window",
      status: "active",
      timezone: "Europe/Moscow",
      startsAt: new Date("2026-06-08T05:00:00.000Z"),
      endsAt: new Date("2026-06-08T08:00:00.000Z"),
      nextFireAt: new Date("2026-06-08T05:00:00.000Z"),
      recurrenceRule: null,
      intervalMinutes: 30,
      requireAck: true,
      maxOccurrences: null,
      quietHours: null,
      escalationPolicy: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.getPolicyForReminder.mockResolvedValue({ policy, reminder: { id: "reminder-id" } });

    await advancePolicyAfterDelivery("reminder-id", new Date("2026-06-08T05:00:00.000Z"));

    expect(mocks.updateReminderPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ nextFireAt: new Date("2026-06-08T05:30:00.000Z") }),
    );
    expect(mocks.createReminderIfMissing).toHaveBeenCalledTimes(1);
  });

  it("does not revive a completed policy when an already queued reminder is delivered", async () => {
    // Production 2026-10-15: an acknowledged NBA policy kept sending bare hourly cards.
    mocks.getPolicyForReminder.mockResolvedValue({
      policy: { ...makePolicy(), status: "completed", nextFireAt: null },
      reminder: { id: "reminder-id" },
    });

    const result = await advancePolicyAfterDelivery(
      "reminder-id",
      new Date("2026-06-08T05:00:00.000Z"),
    );

    expect(result).toBeNull();
    expect(mocks.markPolicyOccurrenceDelivered).toHaveBeenCalledTimes(1);
    expect(mocks.updateReminderPolicy).not.toHaveBeenCalled();
    expect(mocks.createReminderIfMissing).not.toHaveBeenCalled();
  });

  it("restores a cancelled reminder when rematerializing the same policy slot", async () => {
    const policy = makePolicy();
    const scheduledAt = new Date("2026-06-08T05:00:00.000Z");
    mocks.createReminderIfMissing.mockResolvedValueOnce(null);
    mocks.restoreReminderByIdempotencyKey.mockResolvedValueOnce({ id: "restored-reminder" });

    const result = await materializeNextPolicyReminder(policy, scheduledAt, {
      now: new Date("2026-06-08T04:00:00.000Z"),
    });

    expect(result).toEqual({ id: "restored-reminder" });
    expect(mocks.restoreReminderByIdempotencyKey).toHaveBeenCalledWith({
      userId: policy.userId,
      idempotencyKey: `policy:${policy.id}:${scheduledAt.toISOString()}`,
      scheduledAt,
    });
    expect(mocks.attachOccurrenceReminder).toHaveBeenCalledWith({
      policyId: policy.id,
      scheduledFor: scheduledAt,
      reminderId: "restored-reminder",
    });
  });

  it("keeps weekly and biweekly reminders as two long-term policies", async () => {
    await applyAgentReminderPolicies({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T08:00:00.000Z"),
      availableItems: [],
      proposals: [
        {
          operation: "create_recurring_policy",
          itemIds: [],
          itemTitle: null,
          title: "Замена зеркала автомобиля",
          category: "recurring_car",
          policyType: "long_term",
          startsAtLocal: null,
          endsAtLocal: null,
          nextFireAtLocal: "2026-06-14T09:30:00",
          recurrenceRule: "weekly",
          intervalMinutes: null,
          requireAck: true,
          maxOccurrences: null,
          minutesBefore: null,
        },
        {
          operation: "create_recurring_policy",
          itemIds: [],
          itemTitle: null,
          title: "Оплатить ЖКХ",
          category: "recurring_finance",
          policyType: "long_term",
          startsAtLocal: null,
          endsAtLocal: null,
          nextFireAtLocal: "2026-06-21T09:30:00",
          recurrenceRule: "every_2_weeks",
          intervalMinutes: null,
          requireAck: true,
          maxOccurrences: null,
          minutesBefore: null,
        },
      ],
    });

    expect(mocks.createReminderPolicyIfMissing).toHaveBeenCalledTimes(2);
    expect(mocks.createReminderPolicyIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({ category: "recurring_car", recurrenceRule: "weekly" }),
    );
    expect(mocks.createReminderPolicyIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "recurring_finance",
        recurrenceRule: "every_2_weeks",
      }),
    );
  });
});

function makeItem() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "user-id",
    kind: "task",
    status: "active",
    title: "Записать кружок с анонсом винбокса",
    timezone: "Europe/Moscow",
    startAt: null,
    endAt: null,
    dueAt: new Date("2026-06-08T08:00:00.000Z"),
    metadata: {},
  } as never;
}

function makePolicy() {
  return {
    id: "policy-id",
    userId: "user-id",
    itemId: "item-id",
    title: "Reminder",
    category: "people",
    policyType: "one_time",
    status: "active",
    timezone: "UTC",
    startsAt: new Date("2026-06-08T05:00:00.000Z"),
    endsAt: null,
    nextFireAt: new Date("2026-06-08T05:00:00.000Z"),
    recurrenceRule: null,
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHours: null,
    escalationPolicy: null,
    metadata: { allowDuringQuietHours: true },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never;
}
