import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveDashboard: vi.fn(),
  createActiveDashboard: vi.fn(),
  markDashboardStatus: vi.fn(),
  listRecentRangeItems: vi.fn(),
  listActiveReminderPolicies: vi.fn(),
  listLongTermReminderPolicies: vi.fn(),
  listLegacyReminderLikeItems: vi.fn(),
  listPinnedContextNotes: vi.fn(),
  registerBotMessage: vi.fn(),
  deleteMessageSafe: vi.fn(),
  removeKeyboardSafe: vi.fn(),
  listCalendarSyncStatesForUser: vi.fn(),
  rememberTaskView: vi.fn(),
  listVisibleExternalCalendarEvents: vi.fn(),
  getCalendarImportState: vi.fn(),
  reconcileActiveReminderPolicies: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/db/queries/liveDashboards", () => ({
  getActiveDashboard: mocks.getActiveDashboard,
  createActiveDashboard: mocks.createActiveDashboard,
  markDashboardStatus: mocks.markDashboardStatus,
}));
vi.mock("@/db/queries/items", () => ({
  listRecentRangeItems: mocks.listRecentRangeItems,
  listVisibleActivePlanItems: (...args: unknown[]) => mocks.listRecentRangeItems(...args),
  listLegacyReminderLikeItems: mocks.listLegacyReminderLikeItems,
  listPinnedContextNotes: mocks.listPinnedContextNotes,
}));
vi.mock("@/db/queries/reminderPolicies", () => ({
  listActiveReminderPolicies: mocks.listActiveReminderPolicies,
  listLongTermReminderPolicies: mocks.listLongTermReminderPolicies,
}));
vi.mock("@/telegram/messageLifecycle", () => ({
  registerBotMessage: mocks.registerBotMessage,
  deleteMessageSafe: mocks.deleteMessageSafe,
  removeKeyboardSafe: mocks.removeKeyboardSafe,
}));
vi.mock("@/db/queries/googleCalendar", () => ({
  listCalendarSyncStatesForUser: mocks.listCalendarSyncStatesForUser,
}));
vi.mock("@/db/queries/externalCalendarEvents", () => ({
  listVisibleExternalCalendarEvents: mocks.listVisibleExternalCalendarEvents,
  getCalendarImportState: mocks.getCalendarImportState,
}));
vi.mock("@/services/reminderPolicyReconciler", () => ({
  reconcileActiveReminderPolicies: mocks.reconcileActiveReminderPolicies,
}));
vi.mock("@/db/queries/audit", () => ({
  writeAudit: mocks.writeAudit,
}));
vi.mock("@/bot/createBot", () => ({
  getBot: () => ({ api: {} }),
}));
vi.mock("@/agent/state/taskViewState", () => ({
  rememberTaskView: mocks.rememberTaskView,
}));

import {
  renderLiveDashboard,
  renderReminderPolicyList,
  sendOrRefreshLiveDashboard,
} from "@/telegram/liveDashboard";

describe("live dashboard lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getActiveDashboard.mockResolvedValue({
      id: "old-dashboard",
      messageId: 10,
    });
    mocks.deleteMessageSafe.mockResolvedValue(true);
    mocks.createActiveDashboard.mockResolvedValue({ id: "new-dashboard" });
    mocks.listRecentRangeItems.mockResolvedValue([
      {
        id: "event-id",
        status: "active",
        kind: "event",
        title: "Эфир ВС",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-06-07T10:00:00.000Z"),
        endAt: new Date("2026-06-07T17:00:00.000Z"),
        dueAt: null,
      },
    ]);
    mocks.listActiveReminderPolicies.mockResolvedValue([]);
    mocks.listLongTermReminderPolicies.mockResolvedValue([]);
    mocks.listLegacyReminderLikeItems.mockResolvedValue([]);
    mocks.listPinnedContextNotes.mockResolvedValue([]);
    mocks.listCalendarSyncStatesForUser.mockResolvedValue([]);
    mocks.listVisibleExternalCalendarEvents.mockResolvedValue([]);
    mocks.getCalendarImportState.mockResolvedValue(null);
    mocks.reconcileActiveReminderPolicies.mockResolvedValue({
      checked: 0,
      materialized: 0,
      advanced: 0,
      expired: 0,
    });
    mocks.rememberTaskView.mockResolvedValue({ id: "view-id" });
  });

  it("keeps an event visible and shows pending calendar retry", async () => {
    mocks.listCalendarSyncStatesForUser.mockResolvedValue([
      {
        sync: {
          plannerItemId: "event-id",
          status: "pending_retry",
          lastError: "timeout",
        },
      },
    ]);

    const result = await renderLiveDashboard({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T08:00:00.000Z"),
    });

    expect(result.text).toContain("Эфир ВС");
    expect(result.text).toContain("Календарь: timeout, повторю автоматически");
  });

  it("moves same-day past active items out of Today and into Unresolved", async () => {
    mocks.listRecentRangeItems.mockResolvedValue([
      {
        id: "past-run",
        status: "active",
        kind: "event",
        title: "Красочный забег",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-06-07T07:00:00.000Z"),
        endAt: new Date("2026-06-07T08:00:00.000Z"),
        dueAt: null,
        priority: 3,
        visibility: "active",
        metadata: {},
      },
      {
        id: "future-training",
        status: "active",
        kind: "training",
        title: "Тренировка Z2",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-06-07T19:00:00.000Z"),
        endAt: null,
        dueAt: null,
        priority: 3,
        visibility: "active",
        metadata: {},
      },
    ]);

    const result = await renderLiveDashboard({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T10:00:00.000Z"),
    });

    const todayStart = result.text.indexOf("Сегодня — события:");
    expect(todayStart).toBeGreaterThanOrEqual(0);
    expect(result.text.slice(todayStart)).not.toContain("Красочный забег");
    expect(result.text.slice(todayStart)).toContain("Тренировка Z2");
  });

  it("retires the previous dashboard and leaves exactly one new active dashboard", async () => {
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      deleteMessage: vi.fn(),
      editMessageReplyMarkup: vi.fn(),
    };

    const result = await sendOrRefreshLiveDashboard({
      userId: "user-id",
      chatId: "42",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T08:00:00.000Z"),
      api,
    });

    expect(mocks.deleteMessageSafe).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "42", messageId: 10 }),
    );
    expect(mocks.markDashboardStatus).toHaveBeenCalledWith("old-dashboard", "deleted");
    expect(api.sendMessage).toHaveBeenCalledWith(
      "42",
      expect.stringContaining("Эфир ВС"),
      expect.objectContaining({
        reply_markup: expect.anything(),
        disable_notification: true,
      }),
    );
    expect(mocks.createActiveDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 11 }),
    );
    expect(mocks.registerBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "dashboard", messageId: 11 }),
    );
    expect(result.items).toHaveLength(1);
  });

  it("keeps the existing card on an automatic refresh when the plan text is unchanged", async () => {
    const params = {
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-07T08:00:00.000Z"),
    };
    const { text } = await renderLiveDashboard(params);
    mocks.getActiveDashboard.mockResolvedValue({
      id: "old-dashboard",
      messageId: 10,
      payload: { text },
    });
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
      deleteMessage: vi.fn(),
      editMessageReplyMarkup: vi.fn(),
    };

    const automatic = await sendOrRefreshLiveDashboard({
      ...params,
      chatId: "42",
      api,
      skipIfUnchanged: true,
    });
    expect(automatic.unchanged).toBe(true);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mocks.deleteMessageSafe).not.toHaveBeenCalled();

    const explicit = await sendOrRefreshLiveDashboard({ ...params, chatId: "42", api });
    expect(explicit.unchanged).toBe(false);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("reports legacy reminder-like notes instead of claiming reminders are empty", async () => {
    mocks.listActiveReminderPolicies.mockResolvedValue([]);
    mocks.listLegacyReminderLikeItems.mockResolvedValue([
      {
        id: "legacy-id",
        title: "Регулярное напоминание по ЖКХ",
        visibility: "active",
      },
    ]);

    const text = await renderReminderPolicyList({
      userId: "user-id",
      timezone: "Europe/Moscow",
    });

    expect(text).toContain("Активные политики: 0");
    expect(text).toContain("старых записей");
    expect(text).toContain("Регулярное напоминание по ЖКХ");
    expect(text).toContain("без policy");
  });

  it("shows a tomorrow one-day nag under Soon and weekly reminders under Distant", async () => {
    mocks.listRecentRangeItems.mockResolvedValue([]);
    mocks.listActiveReminderPolicies.mockResolvedValue([
      {
        id: "tomorrow-nag",
        title: "Записаться к Дрик",
        policyType: "nag_until_ack",
        category: "people",
        timezone: "Europe/Moscow",
        startsAt: new Date("2026-06-10T05:00:00.000Z"),
        endsAt: new Date("2026-06-10T19:00:00.000Z"),
        nextFireAt: new Date("2026-06-10T05:00:00.000Z"),
        intervalMinutes: 30,
      },
      {
        id: "mirror",
        title: "Заменить зеркало",
        policyType: "long_term",
        category: "recurring_car",
        timezone: "Europe/Moscow",
        startsAt: null,
        endsAt: null,
        nextFireAt: new Date("2026-06-16T06:30:00.000Z"),
        intervalMinutes: null,
      },
    ]);
    mocks.listLongTermReminderPolicies.mockResolvedValue([
      {
        id: "mirror",
        title: "Заменить зеркало",
        policyType: "long_term",
        category: "recurring_car",
        timezone: "Europe/Moscow",
        startsAt: null,
        endsAt: null,
        nextFireAt: new Date("2026-06-16T06:30:00.000Z"),
        intervalMinutes: null,
      },
    ]);

    const result = await renderLiveDashboard({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-09T05:00:00.000Z"),
    });

    expect(result.text).toContain("Сегодня — напоминания:");
    expect(result.text).toContain("Записаться к Дрик");
    expect(result.text).not.toContain("Долгосрочные правила:");
    expect(result.text).toContain("Заменить зеркало");
    expect(result.text.indexOf("Записаться к Дрик")).toBeLessThan(
      result.text.indexOf("Заменить зеркало"),
    );
  });

  it("shows tomorrow and soon items when today is empty and saves the same item order", async () => {
    mocks.listRecentRangeItems.mockResolvedValue([
      {
        id: "tomorrow-item",
        status: "active",
        kind: "task",
        title: "Рекап Дня на ЧМ-26",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-06-13T04:00:00.000Z"),
        endAt: null,
        dueAt: null,
        priority: 3,
        metadata: {},
        createdAt: new Date("2026-06-12T08:00:00.000Z"),
        updatedAt: new Date("2026-06-12T08:00:00.000Z"),
      },
      {
        id: "soon-item",
        status: "active",
        kind: "event",
        title: "Студия Central Park",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-06-16T05:00:00.000Z"),
        endAt: new Date("2026-06-16T09:00:00.000Z"),
        dueAt: null,
        priority: 3,
        metadata: {},
        createdAt: new Date("2026-06-12T08:00:00.000Z"),
        updatedAt: new Date("2026-06-12T08:00:00.000Z"),
      },
    ]);

    const result = await renderLiveDashboard({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-12T09:00:00.000Z"),
    });

    expect(result.text).toContain("На сегодня нет событий.");
    expect(result.text).toContain("Завтра:");
    expect(result.text).toContain("Рекап Дня на ЧМ-26");
    expect(result.text).toContain("Скоро:");
    expect(result.text).toContain("Студия Central Park");
    expect(mocks.rememberTaskView).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "dashboard",
        items: expect.arrayContaining([
          expect.objectContaining({ id: "tomorrow-item" }),
          expect.objectContaining({ id: "soon-item" }),
        ]),
      }),
    );
  });

  it("uses non-contradictory wording when an event is ongoing and nothing is later today", async () => {
    mocks.listRecentRangeItems.mockResolvedValue([
      {
        id: "ongoing",
        status: "active",
        kind: "event",
        title: "Текущий эфир",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-06-13T07:00:00.000Z"),
        endAt: new Date("2026-06-13T09:00:00.000Z"),
        dueAt: null,
        priority: 3,
        visibility: "active",
        metadata: {},
      },
    ]);

    const result = await renderLiveDashboard({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-13T08:00:00.000Z"),
    });

    expect(result.text).toContain("Сейчас / идёт:");
    expect(result.text).toContain("Сегодня — события:");
    expect(result.text).toContain("Больше событий сегодня нет.");
    expect(result.text).not.toContain("На сегодня нет событий.");
  });

  it("hides background post-event follow-up policies from the normal plan", async () => {
    mocks.listRecentRangeItems.mockResolvedValue([
      {
        id: "call-id",
        status: "active",
        kind: "event",
        title: "Созвон с Винлайном по ЧМ",
        timezone: "Europe/Moscow",
        startAt: new Date("2026-06-17T12:30:00.000Z"),
        endAt: new Date("2026-06-17T13:30:00.000Z"),
        dueAt: null,
        priority: 3,
        visibility: "active",
        metadata: {},
      },
    ]);
    mocks.listActiveReminderPolicies.mockResolvedValue([
      {
        id: "before-call",
        userId: "user-id",
        itemId: "call-id",
        title: "Созвон с Винлайном по ЧМ",
        policyType: "before_event",
        category: "pre_event",
        status: "active",
        timezone: "Europe/Moscow",
        startsAt: new Date("2026-06-17T10:30:00.000Z"),
        nextFireAt: new Date("2026-06-17T10:30:00.000Z"),
        metadata: { minutesBefore: 120 },
      },
      {
        id: "post-call",
        userId: "user-id",
        itemId: "call-id",
        title: "Спросить как прошло",
        policyType: "after_event",
        category: "followup",
        status: "active",
        timezone: "Europe/Moscow",
        startsAt: new Date("2026-06-17T13:30:00.000Z"),
        nextFireAt: new Date("2026-06-17T13:30:00.000Z"),
        metadata: { followupPrompt: "спросить как прошло" },
      },
    ]);

    const result = await renderLiveDashboard({
      userId: "user-id",
      timezone: "Europe/Moscow",
      now: new Date("2026-06-17T08:00:00.000Z"),
    });

    expect(result.text).toContain("<b>1</b> ·");
    expect(result.text).toContain("⏰ за 2 часа");
    expect(result.text).not.toContain("Спросить как прошло");
    expect(result.text).not.toContain("после события");
    expect(result.policies.map((policy) => policy.id)).not.toContain("post-call");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "assistant.plan_rendered",
        details: expect.objectContaining({ hiddenBackgroundPolicies: 1 }),
      }),
    );
  });
});
