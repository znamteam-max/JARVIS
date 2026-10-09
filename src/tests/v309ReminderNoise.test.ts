import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDueReminders: vi.fn(),
  isReminderStillDeliverable: vi.fn(),
  getUserById: vi.fn(),
  getPlannerItemByAnyId: vi.fn(),
  getReminderPolicyById: vi.fn(),
  advancePolicyAfterDelivery: vi.fn(),
  recordPendingPromptRenag: vi.fn(),
  runDuePendingPromptRenags: vi.fn(),
}));

vi.mock("@/db/queries/reminders", () => ({
  claimDueReminders: mocks.claimDueReminders,
  createReminderIfMissing: vi.fn(),
  isReminderStillDeliverable: mocks.isReminderStillDeliverable,
  markReminderFailed: vi.fn(),
  markReminderSent: vi.fn(),
  recordReminderDelivery: vi.fn(),
  archiveDeliveredTestItem: vi.fn(),
}));
vi.mock("@/db/queries/users", () => ({ getUserById: mocks.getUserById, listUsers: vi.fn().mockResolvedValue([]) }));
vi.mock("@/db/queries/items", () => ({
  getPlannerItemByAnyId: mocks.getPlannerItemByAnyId,
  listDailyDigestItems: vi.fn().mockResolvedValue([]),
  listEveningReviewItems: vi.fn().mockResolvedValue([]),
  listYesterdayCarryCandidates: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  getReminderPolicyById: mocks.getReminderPolicyById,
}));
vi.mock("@/services/reminderPolicyEngine", () => ({
  advancePolicyAfterDelivery: mocks.advancePolicyAfterDelivery,
}));
vi.mock("@/bot/createBot", () => ({ getBot: () => ({ api: { sendMessage: vi.fn() } }) }));
vi.mock("@/services/reminderPolicyReconciler", () => ({
  reconcileActiveReminderPolicies: vi
    .fn()
    .mockResolvedValue({ checked: 0, materialized: 0, advanced: 0, expired: 0 }),
}));
vi.mock("@/db/queries/schedulerHealth", () => ({
  recordRunnerStarted: vi.fn().mockResolvedValue(undefined),
  recordPolicyReconcile: vi.fn().mockResolvedValue(undefined),
  recordRunnerFinished: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/db/queries/runtimeLocks", () => ({
  acquireRuntimeLease: vi.fn().mockResolvedValue({ key: "reminder_runner" }),
  releaseRuntimeLease: vi.fn().mockResolvedValue({ key: "reminder_runner" }),
}));
vi.mock("@/services/pendingPromptRenag", () => ({
  recordPendingPromptRenag: mocks.recordPendingPromptRenag,
  runDuePendingPromptRenags: mocks.runDuePendingPromptRenags,
}));
vi.mock("@/agent/state/taskViewState", () => ({
  rememberTaskView: vi.fn().mockResolvedValue({ id: "view-id" }),
}));

import { runDueReminders } from "@/jobs/runDueReminders";

const now = new Date("2026-09-25T04:50:00.000Z");

function policyReminder() {
  return {
    id: "reminder-id",
    userId: "user-id",
    plannerItemId: "item-id",
    policyId: "policy-id",
    type: "until_ack",
    purpose: null,
    scheduledAt: now,
    status: "claimed",
    claimedAt: now,
    sentAt: null,
    telegramMessageId: null,
    attemptCount: 1,
    lastError: null,
    repeatUntilAck: false,
    ackedAt: null,
    parentReminderId: null,
    recurrenceKey: null,
    payload: {},
    createdAt: now,
    updatedAt: now,
  };
}

function policy(overrides: Record<string, unknown>) {
  return {
    id: "policy-id",
    userId: "user-id",
    itemId: "item-id",
    title: "Проверять резюме криаторов",
    category: "task",
    policyType: "nag_until_ack",
    timezone: "Europe/Moscow",
    intervalMinutes: 240,
    requireAck: true,
    metadata: {},
    quietHours: null,
    startsAt: null,
    endsAt: null,
    snoozedUntil: null,
    ...overrides,
  };
}

describe("V3.0.9 reminder noise: re-nag only when nothing else will follow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({
      id: "user-id",
      telegramUserId: 52203584n,
      timezone: "Europe/Moscow",
    });
    mocks.getPlannerItemByAnyId.mockResolvedValue({
      id: "item-id",
      kind: "task",
      title: "Проверять резюме криаторов",
      timezone: "Europe/Moscow",
      startAt: null,
      endAt: null,
      dueAt: null,
      metadata: {},
    });
    mocks.isReminderStillDeliverable.mockResolvedValue(true);
    mocks.claimDueReminders.mockResolvedValue([policyReminder()]);
    mocks.advancePolicyAfterDelivery.mockResolvedValue(null);
    mocks.recordPendingPromptRenag.mockResolvedValue({ id: "renag-id" });
    mocks.runDuePendingPromptRenags.mockResolvedValue({ checked: 0, sent: 0, cancelled: 0 });
  });

  it("does not stack 5-minute re-nags when the policy has its own next reminder", async () => {
    mocks.getReminderPolicyById.mockResolvedValue(
      policy({ status: "active", nextFireAt: new Date("2026-09-25T08:50:00.000Z") }),
    );
    const sender = { sendMessage: vi.fn().mockResolvedValue({ message_id: 5916 }) };

    await runDueReminders({ now, sender });

    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.advancePolicyAfterDelivery).toHaveBeenCalledWith("reminder-id", now);
    expect(mocks.recordPendingPromptRenag).not.toHaveBeenCalled();
  });

  it("keeps the re-nag when the policy has no further reminder", async () => {
    mocks.getReminderPolicyById.mockResolvedValue(
      policy({ status: "completed", nextFireAt: null, policyType: "one_time" }),
    );
    const sender = { sendMessage: vi.fn().mockResolvedValue({ message_id: 5917 }) };

    await runDueReminders({ now, sender });

    expect(mocks.recordPendingPromptRenag).toHaveBeenCalledWith(
      expect.objectContaining({ targetReminderId: "reminder-id", targetPolicyId: "policy-id" }),
    );
  });

  it("keeps the re-nag when the policy lookup fails", async () => {
    mocks.getReminderPolicyById
      .mockResolvedValueOnce(policy({ status: "active", nextFireAt: null }))
      .mockRejectedValueOnce(new Error("db unavailable"));
    const sender = { sendMessage: vi.fn().mockResolvedValue({ message_id: 5918 }) };

    await runDueReminders({ now, sender });

    expect(mocks.recordPendingPromptRenag).toHaveBeenCalled();
  });
});
