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
  listEveningReviewItems: vi.fn(),
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
vi.mock("@/db/queries/users", () => ({
  getUserById: mocks.getUserById,
  listUsers: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/db/queries/items", () => ({
  getPlannerItemByAnyId: mocks.getPlannerItemByAnyId,
  listDailyDigestItems: vi.fn().mockResolvedValue([]),
  listEveningReviewItems: mocks.listEveningReviewItems,
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
vi.mock("@/services/dailyHistory", () => ({ ensureDailySnapshot: vi.fn() }));
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
    mocks.listEveningReviewItems.mockResolvedValue([]);
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

describe("V3.0.9 overdue until-done card", () => {
  it("says how long the task is overdue instead of repeating the stale date", async () => {
    const { formatReminderMessage } = await import("@/bot/formatters");
    const text = formatReminderMessage(
      { ...policyReminder(), policyId: null, repeatUntilAck: true } as never,
      {
        id: "item-id",
        kind: "recurring_task",
        title: "Записаться на боевое искусство",
        timezone: "Europe/Moscow",
        startAt: null,
        endAt: null,
        dueAt: new Date("2026-09-20T20:59:00.000Z"),
        metadata: {},
      } as never,
      { now: new Date("2026-09-25T06:30:00.000Z") },
    );

    expect(text).toContain("Записаться на боевое искусство");
    expect(text).toContain("Срок был Вс, 20.09 23:59 — просрочено на 5 дней.");
    expect(text).toContain("отложи кнопкой");
  });
});

describe("V3.0.9 evening check", () => {
  it("lists open tasks but not meetings that already happened", async () => {
    vi.clearAllMocks();
    const evening = new Date("2026-10-08T15:00:00.000Z");
    mocks.getUserById.mockResolvedValue({
      id: "user-id",
      telegramUserId: 52203584n,
      timezone: "Europe/Moscow",
    });
    mocks.isReminderStillDeliverable.mockResolvedValue(true);
    mocks.runDuePendingPromptRenags.mockResolvedValue({ checked: 0, sent: 0, cancelled: 0 });
    mocks.claimDueReminders.mockResolvedValue([
      {
        ...policyReminder(),
        policyId: null,
        plannerItemId: null,
        type: "evening_checkin",
        scheduledAt: evening,
      },
    ]);
    mocks.listEveningReviewItems.mockResolvedValue([
      {
        id: "event-id",
        kind: "event",
        status: "active",
        title: "Прямой эфир Централ Парк про триатлон",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-10-08T08:00:00.000Z"),
        endAt: new Date("2026-10-08T09:00:00.000Z"),
        dueAt: null,
        metadata: {},
      },
      {
        id: "task-id",
        kind: "task",
        status: "active",
        title: "Сделать видео с Сэмом",
        timezone: "Europe/Moscow",
        startAt: null,
        endAt: null,
        dueAt: new Date("2026-10-08T20:00:00.000Z"),
        metadata: {},
      },
    ]);
    const sender = { sendMessage: vi.fn().mockResolvedValue({ message_id: 6584 }) };

    await runDueReminders({ now: evening, sender });

    const text = String(sender.sendMessage.mock.calls[0]?.[1]);
    expect(text).toContain("Сделать видео с Сэмом");
    expect(text).not.toContain("Централ Парк");
  });
});
