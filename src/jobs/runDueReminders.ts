import { DateTime } from "luxon";
import { randomUUID } from "node:crypto";

import {
  getPlannerItemByAnyId,
  listDailyDigestItems,
  listEveningReviewItems,
  listYesterdayCarryCandidates,
} from "@/db/queries/items";
import { getReminderPolicyById } from "@/db/queries/reminderPolicies";
import {
  archiveDeliveredTestItem,
  claimDueReminders,
  createReminderIfMissing,
  isReminderStillDeliverable,
  markReminderFailed,
  markReminderSent,
  recordReminderDelivery,
  type ClaimedReminder,
} from "@/db/queries/reminders";
import { getUserById } from "@/db/queries/users";
import { logger } from "@/lib/logger";
import { renderAndSaveTaskView } from "@/agent/views/renderAndSaveTaskView";
import { sortJarvisItemsForDisplay } from "@/agent/views/renderShared";

import { getBot } from "@/bot/createBot";
import { advancePolicyAfterDelivery } from "@/services/reminderPolicyEngine";
import { registerBotMessage } from "@/telegram/messageLifecycle";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";
import { reconcileActiveReminderPolicies } from "@/services/reminderPolicyReconciler";
import {
  recordPolicyReconcile,
  recordRunnerFinished,
  recordRunnerStarted,
} from "@/db/queries/schedulerHealth";
import { acquireRuntimeLease, releaseRuntimeLease } from "@/db/queries/runtimeLocks";
import { syncCompactChat } from "@/telegram/compactChatOrchestrator";
import type { LiveDashboardTelegramApi } from "@/telegram/liveDashboard";
import { ensureDailySnapshot } from "@/services/dailyHistory";
import { runDueCalendarSyncRetries } from "@/services/calendarSyncRetry";
import { runDueYandexCalendarImports } from "@/services/yandexCalendarImport";
import { isEventLikePlannerItem } from "@/domain/eventReminderSemantics";
import { recordPendingPromptRenag, runDuePendingPromptRenags } from "@/services/pendingPromptRenag";
import { renderActionableReminderCard } from "@/telegram/reminderCard";
import { auditTelegramDelivery, withTelegramDeliveryPolicy } from "@/telegram/deliveryPolicy";

export type ReminderTelegramSender = {
  sendMessage(
    chatId: string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<{ message_id?: number }>;
  editMessageText?(
    chatId: string,
    messageId: number,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  deleteMessage?(chatId: string, messageId: number): Promise<unknown>;
};

export async function runDueReminders(params?: {
  now?: Date;
  limit?: number;
  sender?: ReminderTelegramSender;
}) {
  const now = params?.now ?? new Date();
  const limit = params?.limit ?? 50;
  const sender = params?.sender ?? getBot().api;
  const leaseOwner = randomUUID();
  const lease = await acquireRuntimeLease({
    key: "reminder_runner",
    ownerToken: leaseOwner,
    now,
    leaseSeconds: 55,
  });
  if (!lease) {
    return {
      claimed: 0,
      sent: 0,
      failed: 0,
      skipped: true,
      reason: "runner_already_active" as const,
    };
  }

  try {
    await recordRunnerStarted(now).catch((error) => {
      logger.warn("Runner start observability failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    let reconcile = { checked: 0, materialized: 0, advanced: 0, expired: 0 };
    try {
      reconcile = await reconcileActiveReminderPolicies({ now, limit: limit * 4 });
      await recordPolicyReconcile({
        at: now,
        checked: reconcile.checked,
        created: reconcile.materialized,
      });
    } catch (error) {
      logger.warn("Reminder policy reconciliation failed without blocking legacy reminders", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const due = await claimDueReminders({ now, limit });
    const results = { claimed: due.length, sent: 0, failed: 0 };

    for (const reminder of due) {
      try {
        const deliverable = await isReminderStillDeliverable({
          reminderId: reminder.id,
          now: new Date(),
        });
        if (!deliverable) continue;
        const compactDelivery = !params?.sender && !isDigestReminder(reminder);
        const sentMessage = await sendReminder(reminder, sender, {
          compact: compactDelivery,
          now,
        });
        await markReminderSent({
          reminderId: reminder.id,
          telegramMessageId: sentMessage.message_id,
        });
        await recordReminderDelivery({
          reminder,
          status: "sent",
          telegramMessageId: sentMessage.message_id,
        });
        const autoArchivedTest = await archiveTestReminderIfNeeded(reminder);
        if (!autoArchivedTest) {
          if (reminder.policyId) {
            await advancePolicyAfterDelivery(reminder.id, now);
          } else {
            await scheduleRepeatUntilAck(reminder, now);
            await scheduleNextRecurringOccurrence(reminder, now);
          }
        }
        if (
          sentMessage.actionRequired &&
          sentMessage.text &&
          !(await policyWillRemindAgain(reminder, now))
        ) {
          await recordPendingPromptRenag({
            userId: reminder.userId,
            promptType:
              reminder.purpose ??
              (isPostEventReminder(reminder) ? "post_event_menu" : reminder.type),
            text: sentMessage.text,
            targetReminderId: reminder.id,
            targetItemId: sentMessage.targetItemId ?? reminder.plannerItemId,
            targetPolicyId: sentMessage.targetPolicyId ?? reminder.policyId,
            renderMode: sentMessage.renderMode,
            allowedActions: sentMessage.allowedActions,
            buttonsAttached: sentMessage.buttonsAttached,
            lastTelegramMessageId: sentMessage.message_id ?? null,
            now,
          }).catch((error) => {
            logger.warn("Pending action prompt registration failed", {
              reminderId: reminder.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        if (!params?.sender && sentMessage.message_id && !compactDelivery) {
          const user = await getUserById(reminder.userId);
          if (user) {
            await registerBotMessage({
              userId: reminder.userId,
              chatId: user.telegramUserId.toString(),
              messageId: sentMessage.message_id,
              purpose:
                reminder.purpose ?? (isPostEventReminder(reminder) ? "followup" : "reminder"),
              relatedItemId: reminder.plannerItemId,
              relatedReminderId: reminder.id,
            });
          }
        }
        if (!params?.sender && !compactDelivery)
          await refreshReminderDashboardBestEffort(reminder, now);
        results.sent += 1;
      } catch (error) {
        results.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        await markReminderFailed({
          reminder,
          error: message,
          retryAt: nextRetryAt(reminder, now),
        });
        await recordReminderDelivery({ reminder, status: "failed", error: message });
        logger.warn("Reminder send failed", { reminderId: reminder.id, error: message });
      }
    }

    await scheduleTomorrowDigests(now);
    try {
      await runDuePendingPromptRenags({ now, sender, limit: 10 });
    } catch (error) {
      logger.warn("Pending prompt re-nag failed without blocking reminders", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await runDueCalendarSyncRetries({ now, limit: 3 });
    } catch (error) {
      logger.warn("Calendar retry queue failed without blocking reminders", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await runDueYandexCalendarImports({ now, minimumIntervalMinutes: 15, limit: 3 });
    } catch (error) {
      logger.warn("Calendar inbound import failed without blocking reminders", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await recordRunnerFinished({
      at: new Date(),
      claimed: results.claimed,
      sent: results.sent,
      failed: results.failed,
    }).catch((error) => {
      logger.warn("Runner finish observability failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return results;
  } finally {
    await releaseRuntimeLease({
      key: "reminder_runner",
      ownerToken: leaseOwner,
    }).catch((error) => {
      logger.warn("Runner lease release failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function sendReminder(
  reminder: ClaimedReminder,
  sender: ReminderTelegramSender,
  options?: { compact?: boolean; now?: Date },
) {
  const user = await getUserById(reminder.userId);
  if (!user) throw new Error("Reminder user not found");

  if (reminder.type === "morning_digest") {
    const nowLocal = DateTime.fromJSDate(reminder.scheduledAt, { zone: "utc" }).setZone(
      user.timezone,
    );
    const from = nowLocal.startOf("day").toUTC().toJSDate();
    const to = nowLocal.endOf("day").toUTC().toJSDate();
    const yesterdayFrom = nowLocal.minus({ days: 1 }).startOf("day").toUTC().toJSDate();
    const yesterdayTo = nowLocal.minus({ days: 1 }).endOf("day").toUTC().toJSDate();
    const [items, carry] = await Promise.all([
      listDailyDigestItems({ userId: user.id, from, to, limit: 80 }),
      listYesterdayCarryCandidates({
        userId: user.id,
        from: yesterdayFrom,
        to: yesterdayTo,
        limit: 10,
      }),
    ]);
    const rendered = await renderAndSaveTaskView({
      userId: user.id,
      timezone: user.timezone,
      viewType: "today",
      title: `Сегодня, ${nowLocal.setLocale("ru").toFormat("d MMMM")}`,
      sections: [
        { title: "На сегодня", items: sortJarvisItemsForDisplay(items) },
        { title: "Со вчера осталось", items: sortJarvisItemsForDisplay(carry) },
      ],
      emptyText: "Сегодня пока пусто. Можешь надиктовать дела, а я соберу план.",
      metadata: { source: "morning_digest" },
    });
    const sent = await sender.sendMessage(
      user.telegramUserId.toString(),
      rendered.reply,
      withTelegramDeliveryPolicy("dashboard_refresh"),
    );
    await auditTelegramDelivery({
      userId: user.id,
      messageKind: "dashboard_refresh",
      entityType: "reminder",
      entityId: reminder.id,
      targetReminderId: reminder.id,
    });
    return {
      ...sent,
      actionRequired: false,
      text: rendered.reply,
      targetItemId: null,
      targetPolicyId: null,
      renderMode: null,
      allowedActions: [],
      buttonsAttached: false,
    };
  }

  if (reminder.type === "evening_checkin") {
    const nowLocal = DateTime.fromJSDate(reminder.scheduledAt, { zone: "utc" }).setZone(
      user.timezone,
    );
    const from = nowLocal.startOf("day").toUTC().toJSDate();
    const to = nowLocal.endOf("day").toUTC().toJSDate();
    // Meetings already get their own post-event card; the evening check is for open tasks.
    const tasks = (await listEveningReviewItems({ userId: user.id, from, to, limit: 80 })).filter(
      (item) => !isEventLikePlannerItem(item),
    );
    await ensureDailySnapshot({
      userId: user.id,
      timezone: user.timezone,
      localDate: nowLocal.toISODate()!,
    });
    const rendered = await renderAndSaveTaskView({
      userId: user.id,
      timezone: user.timezone,
      viewType: "evening_review",
      title: "Вечерняя проверка",
      sections: [{ title: "Сегодня", items: sortJarvisItemsForDisplay(tasks) }],
      emptyText: "На сегодня незакрытых задач нет.",
      footer: "Что делаем? Можно написать: 1 выполнено, 2 на завтра, всё закрыть.",
      metadata: { source: "evening_checkin" },
    });
    const sent = await sender.sendMessage(
      user.telegramUserId.toString(),
      rendered.reply,
      withTelegramDeliveryPolicy("dashboard_refresh"),
    );
    await auditTelegramDelivery({
      userId: user.id,
      messageKind: "dashboard_refresh",
      entityType: "reminder",
      entityId: reminder.id,
      targetReminderId: reminder.id,
    });
    return {
      ...sent,
      actionRequired: false,
      text: rendered.reply,
      targetItemId: null,
      targetPolicyId: null,
      renderMode: null,
      allowedActions: [],
      buttonsAttached: false,
    };
  }

  const [item, policy] = await Promise.all([
    reminder.plannerItemId ? getPlannerItemByAnyId(reminder.plannerItemId) : null,
    reminder.policyId ? getReminderPolicyById(reminder.policyId) : null,
  ]);
  const card = renderActionableReminderCard({
    reminder,
    item,
    policy,
    now: options?.now ?? new Date(),
  });
  const text = card.text;
  const messageKind = isEventLikePlannerItem(item) ? "event_alert" : "reminder_alert";
  const messageOptions = withTelegramDeliveryPolicy(messageKind, {
    reply_markup: card.keyboard,
  });
  const actionRequired = isActionRequiredReminder(reminder, item);
  if (options?.compact) {
    const synced = await syncCompactChat({
      userId: user.id,
      chatId: user.telegramUserId.toString(),
      timezone: user.timezone,
      reason: "reminder_delivery",
      activeReminder: {
        text,
        options: messageOptions,
        relatedItemId: reminder.plannerItemId,
        relatedReminderId: reminder.id,
      },
      now: options.now,
      api: sender as LiveDashboardTelegramApi,
    });
    await auditReminderSendMode({ user, reminder, messageKind, compact: true });
    return {
      message_id: synced.reminderMessageId ?? undefined,
      actionRequired,
      text,
      targetItemId: item?.id ?? reminder.plannerItemId ?? null,
      targetPolicyId: reminder.policyId ?? null,
      renderMode: card.renderMode,
      allowedActions: card.allowedActions,
      buttonsAttached: card.buttonsAttached,
    };
  }
  const sent = await sender.sendMessage(user.telegramUserId.toString(), text, messageOptions);
  await auditReminderSendMode({ user, reminder, messageKind, compact: false });
  return {
    ...sent,
    actionRequired,
    text,
    targetItemId: item?.id ?? reminder.plannerItemId ?? null,
    targetPolicyId: reminder.policyId ?? null,
    renderMode: card.renderMode,
    allowedActions: card.allowedActions,
    buttonsAttached: card.buttonsAttached,
  };
}

async function auditReminderSendMode(params: {
  user: Awaited<ReturnType<typeof getUserById>>;
  reminder: ClaimedReminder;
  messageKind: "reminder_alert" | "event_alert";
  compact: boolean;
}) {
  if (!params.user) return;
  await auditTelegramDelivery({
    userId: params.user.id,
    messageKind: params.messageKind,
    entityType: "reminder",
    entityId: params.reminder.id,
    targetReminderId: params.reminder.id,
    targetPolicyId: params.reminder.policyId ?? null,
    targetItemId: params.reminder.plannerItemId ?? null,
    details: {
      compact: params.compact,
    },
  });
}

function isPostEventReminder(reminder: ClaimedReminder) {
  return (
    reminder.purpose === "post_event_menu" ||
    reminder.menuType === "event_reaction" ||
    ["followup", "training_followup", "after_event"].includes(reminder.type)
  );
}

function isActionRequiredReminder(
  reminder: ClaimedReminder,
  item: Awaited<ReturnType<typeof getPlannerItemByAnyId>>,
) {
  if (isTestItem(item, reminder)) return false;
  return (
    (isPostEventReminder(reminder) && Boolean(item)) ||
    Boolean(reminder.policyId) ||
    reminder.repeatUntilAck === true ||
    item?.kind === "recurring_task" ||
    (reminder.type === "followup" && item?.kind === "tentative_event") ||
    item?.metadata?.managementButtonsRequested === true ||
    Boolean(item && isEventLikePlannerItem(item))
  );
}

function isTestItem(
  item: Awaited<ReturnType<typeof getPlannerItemByAnyId>>,
  reminder: ClaimedReminder,
) {
  const payload = (reminder.payload ?? {}) as Record<string, unknown>;
  return (
    item?.metadata?.isTest === true ||
    item?.metadata?.debug === true ||
    item?.metadata?.source === "remindertest" ||
    payload.isTest === true ||
    payload.debug === true ||
    payload.source === "remindertest"
  );
}

function isDigestReminder(reminder: ClaimedReminder) {
  return reminder.type === "morning_digest" || reminder.type === "evening_checkin";
}

async function archiveTestReminderIfNeeded(reminder: ClaimedReminder) {
  if (!reminder.plannerItemId) return false;
  const item = await getPlannerItemByAnyId(reminder.plannerItemId);
  const payload = (reminder.payload ?? {}) as Record<string, unknown>;
  const isTest =
    item?.metadata?.isTest === true ||
    item?.metadata?.debug === true ||
    item?.metadata?.source === "remindertest" ||
    payload.isTest === true ||
    payload.debug === true ||
    payload.source === "remindertest";
  if (!isTest) return false;
  await archiveDeliveredTestItem(reminder.userId, reminder.plannerItemId);
  return true;
}

function nextRetryAt(reminder: ClaimedReminder, now: Date): Date | null {
  if (reminder.attemptCount >= 3) return null;
  const minutes = reminder.attemptCount === 1 ? 5 : reminder.attemptCount === 2 ? 15 : 30;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

// The 5-minute re-nag exists so a one-off reminder is not lost. When the policy
// already has its own next occurrence, that occurrence is the follow-up; stacking
// re-nags on top of it ignored the user's interval (e.g. "every 240 minutes").
async function policyWillRemindAgain(reminder: ClaimedReminder, now: Date) {
  if (!reminder.policyId) return false;
  try {
    const policy = await getReminderPolicyById(reminder.policyId);
    return Boolean(
      policy &&
        policy.status === "active" &&
        policy.nextFireAt &&
        policy.nextFireAt.getTime() > now.getTime(),
    );
  } catch (error) {
    logger.warn("Policy follow-up lookup failed; keeping re-nag", {
      reminderId: reminder.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function scheduleRepeatUntilAck(reminder: ClaimedReminder, now: Date) {
  if (!reminder.repeatUntilAck || reminder.ackedAt) return;
  const payload = (reminder.payload ?? {}) as Record<string, unknown>;

  const user = await getUserById(reminder.userId);
  if (!user) return;
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(user.timezone);
  const repeatAtLocal = nowLocal.plus({ minutes: 75 });
  const twoPm = nowLocal.startOf("day").plus({ hours: 14 });
  const repeatAt = (repeatAtLocal < twoPm ? repeatAtLocal : twoPm).toUTC().toJSDate();
  if (repeatAt.getTime() <= now.getTime()) return;

  await createReminderIfMissing({
    userId: reminder.userId,
    plannerItemId: reminder.plannerItemId,
    type: "until_ack",
    idempotencyKey: `${reminder.id}:until_ack:${repeatAt.toISOString()}`,
    scheduledAt: repeatAt,
    repeatUntilAck: true,
    parentReminderId: reminder.parentReminderId ?? reminder.id,
    recurrenceKey: reminder.recurrenceKey,
    payload: { ...payload, untilAckRepeat: true },
  });
}

async function scheduleNextRecurringOccurrence(reminder: ClaimedReminder, now: Date) {
  if (reminder.type !== "recurring") return;
  const payload = (reminder.payload ?? {}) as {
    recurrence?: { daysOfWeek?: string[]; timeLocal?: string; repeatUntilAck?: boolean };
  };
  const recurrence = payload.recurrence;
  if (!recurrence?.daysOfWeek?.length || !recurrence.timeLocal) return;
  const user = await getUserById(reminder.userId);
  if (!user) return;

  const next = findNextRecurringDate({
    now,
    timezone: user.timezone,
    daysOfWeek: recurrence.daysOfWeek,
    timeLocal: recurrence.timeLocal,
  });
  await createReminderIfMissing({
    userId: reminder.userId,
    plannerItemId: reminder.plannerItemId,
    type: "recurring",
    idempotencyKey: `${reminder.plannerItemId}:recurring:${next.toISOString()}`,
    scheduledAt: next,
    repeatUntilAck: recurrence.repeatUntilAck ?? reminder.repeatUntilAck,
    recurrenceKey: reminder.recurrenceKey,
    payload: reminder.payload,
  });
}

function findNextRecurringDate(params: {
  now: Date;
  timezone: string;
  daysOfWeek: string[];
  timeLocal: string;
}): Date {
  const dayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const [hourRaw, minuteRaw] = params.timeLocal.split(":");
  const hour = Number(hourRaw || 9);
  const minute = Number(minuteRaw || 30);
  const targetWeekdays = new Set(
    params.daysOfWeek.map((day) => dayCodes.indexOf(day) + 1).filter((day) => day > 0),
  );
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = nowLocal
      .startOf("day")
      .plus({ days: offset })
      .set({ hour, minute, second: 0, millisecond: 0 });
    if (targetWeekdays.has(candidate.weekday)) return candidate.toUTC().toJSDate();
  }
  return nowLocal.plus({ days: 1 }).toUTC().toJSDate();
}

async function scheduleTomorrowDigests(now: Date) {
  const { listUsers } = await import("@/db/queries/users");
  const users = await listUsers();
  for (const user of users) {
    const localNow = DateTime.fromJSDate(now, { zone: "utc" }).setZone(user.timezone);
    await ensureDailySnapshot({
      userId: user.id,
      timezone: user.timezone,
      localDate: localNow.minus({ days: 1 }).toISODate()!,
    }).catch((error) => {
      logger.warn("Daily history snapshot failed", {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const localTomorrow = localNow.plus({ days: 1 });
    const morning = localTomorrow.startOf("day").plus({ hours: 8 }).toUTC().toJSDate();
    const evening = localTomorrow.startOf("day").plus({ hours: 21 }).toUTC().toJSDate();
    const dateKey = localTomorrow.toISODate();
    await createReminderIfMissing({
      userId: user.id,
      type: "morning_digest",
      idempotencyKey: `${user.id}:morning_digest:${dateKey}`,
      scheduledAt: morning,
      payload: { date: dateKey },
    });
    await createReminderIfMissing({
      userId: user.id,
      type: "evening_checkin",
      idempotencyKey: `${user.id}:evening_checkin:${dateKey}`,
      scheduledAt: evening,
      payload: { date: dateKey },
    });
  }
}

async function refreshReminderDashboardBestEffort(reminder: ClaimedReminder, now: Date) {
  try {
    const user = await getUserById(reminder.userId);
    if (!user) return;
    await refreshDashboardAfterMutation({
      userId: user.id,
      chatId: user.telegramUserId.toString(),
      timezone: user.timezone,
      now,
      skipIfUnchanged: true,
    });
  } catch (error) {
    logger.warn("Reminder dashboard refresh failed", {
      reminderId: reminder.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
