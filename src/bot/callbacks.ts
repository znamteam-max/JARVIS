import { InlineKeyboard, type Bot } from "grammy";
import { DateTime } from "luxon";

import {
  cancelNumberedMutationTool,
  confirmNumberedMutationTool,
  renderScheduleViewTool,
  renderTaskViewTool,
  undoLastActionTool,
} from "@/agent/jarvisTools";
import { getItemCalendarSyncState, markGoogleCalendarSync } from "@/db/queries/googleCalendar";
import {
  disableCalendarSyncForItem,
  getCalendarSyncJobForItem,
} from "@/db/queries/calendarSyncJobs";
import { confirmPendingActionInDb, cancelPendingAction } from "@/db/queries/pendingActions";
import {
  cancelPlannerItem,
  getPlannerItemById,
  listManageableItems,
  markPlannerItemCompleted,
  setPlannerItemManualPriority,
  updatePlannerItemDetails,
} from "@/db/queries/items";
import {
  deleteExternalCalendarEventCache,
  getExternalCalendarEventById,
  hideExternalCalendarEvent,
} from "@/db/queries/externalCalendarEvents";
import { deleteMemoryForUser } from "@/db/queries/memories";
import {
  ackReminderForToday,
  ackReminderOccurrence,
  cancelPendingRemindersForPolicy,
  cancelItemReminders,
  getReminderByIdForUser,
  snoozeReminder,
  snoozeReminderUntil,
  stopRecurringReminders,
} from "@/db/queries/reminders";
import { endOfLocalDay, formatRuWeekdayDateTime, startOfLocalDay } from "@/domain/dateTime";
import { buildDeadlineReminderFireAt } from "@/domain/deadlineSemantics";
import { cancelStoredActionPlan, commitStoredActionPlan } from "@/services/actionPlanCommit";
import {
  formatCalendarSyncFeedback,
  syncItemsToCalendarBestEffort,
} from "@/services/calendarBestEffort";
import { cancelActivePlanReset, executeActivePlanReset } from "@/services/activePlanReset";
import { UserFacingError } from "@/lib/errors";
import {
  createReminderPolicyIfMissing,
  getReminderPolicyById,
  getPolicyForReminder,
  stopPoliciesForItem,
  updatePoliciesPriorityForItem,
  updateReminderPolicy,
  listReminderPoliciesForItem,
} from "@/db/queries/reminderPolicies";
import {
  acknowledgePolicyReminder,
  materializeNextPolicyReminder,
} from "@/services/reminderPolicyEngine";
import {
  applyReminderPolicyRepair,
  previewReminderPolicyRepair,
} from "@/services/reminderPolicyRepair";
import { writeAudit } from "@/db/queries/audit";
import {
  cleanupAfterCallback,
  cleanupPolicyEditorMessages,
  cleanupTransientMessages,
  registerBotMessage,
} from "@/telegram/messageLifecycle";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";
import {
  applyCleanupPreviewSession,
  cancelCleanupPreviewSession,
  getCleanupPreviewSession,
  renderCleanupPreview,
} from "@/services/cleanupPreview";
import type { CleanupCategory } from "@/bot/keyboards";
import {
  archiveCompletedItem,
  renderCompletedItemsView,
  restoreCompletedItem,
} from "@/services/completedItemsView";
import {
  renderReminderControlCenter,
  renderReminderPolicyCard,
} from "@/telegram/reminderControlCenter";
import { editReminderPolicy } from "@/services/reminderPolicyEditor";
import { startReminderPolicyEditSession } from "@/services/reminderPolicyEditSessions";
import {
  completeCampaignEventAndActivateNext,
  markCampaignPreparationDone,
  requiresCampaignCompletionClarification,
  updateCampaignState,
} from "@/services/campaignLifecycle";
import { renderEntityCard } from "@/telegram/entityCards";
import type { EntityRefType } from "@/domain/entityRefs";
import { retryCalendarItem } from "@/services/calendarSyncRetry";
import { detectPlanConflicts, formatConflictLine } from "@/services/planConflicts";
import { startItemEditSession } from "@/services/itemEditSessions";
import { startMultiReminderSetupSession } from "@/services/multiReminderSetupSessions";
import { deleteYandexCalendarObject } from "@/integrations/yandexCalendar";
import { deletePlannerItemEverywhere } from "@/services/plannerItemDelete";
import { parseBeforeEventReminderSpecsForAnchor } from "@/domain/beforeEventReminderParsing";
import {
  isTodayUntilDonePlannerItem,
  isTodayUntilDoneReminderPolicy,
} from "@/domain/todayUntilDoneTask";
import {
  applyReminderSpecsToItem,
  createSeparateEventFromSession,
  finishTargetResolutionAction,
  getEventTargetResolutionSession,
  getReminderTargetResolutionSession,
  itemForCandidate,
} from "@/services/eventTargetResolution";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import {
  beforeEventReminderMenuKeyboard,
  intervalReminderMenuKeyboard,
  campaignCompletionGuardKeyboard,
  entityListKeyboard,
  itemMenuKeyboard,
  itemMoreKeyboard,
  externalCalendarDeleteKeyboard,
  oneTimeReminderMenuKeyboard,
  policyFrequencyKeyboard,
  persistentMarkerKeyboard,
  priorityEditorKeyboard,
  postCreateTriageKeyboard,
  conflictKeyboard,
  reminderPolicyMenuKeyboard,
  recurringTimeClarificationKeyboard,
  repeatPolicyDeleteKeyboard,
  scheduleReminderMenuKeyboard,
  undoActionKeyboard,
  eventReminderExtraChoiceKeyboard,
} from "./keyboards";
import { formatCommittedPlanSummary, formatCreatedItem } from "./formatters";
import {
  cancelItemEditPreview,
  chooseMultiReminderMode,
  confirmItemEditPreview,
} from "./itemEditFlow";
import { startExternalCalendarEditSession } from "./externalCalendarEditFlow";
import { applyRecurringPolicyDraftTime } from "./recurringPolicyDraftFlow";
import {
  finishRecurringPolicyDraftSession,
  startRecurringPolicyDraftSession,
} from "@/services/recurringPolicyDraftSessions";
import {
  finishRecurringPolicyDuplicateDecision,
  getRecurringPolicyDuplicateDecisionSession,
} from "@/services/recurringPolicyDuplicateDetection";
import { replyStaleCallback } from "./callbackReliability";
import {
  scheduleManualEventReminderSnooze,
  scheduleSmartExtraEventReminder,
} from "@/services/eventReminderActions";
import {
  cancelPendingPromptRenagsForTarget,
  recordPendingPromptRenag,
} from "@/services/pendingPromptRenag";
import { isEventLikePlannerItem } from "@/domain/eventReminderSemantics";
import { isPinnedContextNote } from "@/domain/pinnedContextNotes";

export function registerCallbacks(bot: Bot<BotContext>) {
  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^recurring_draft:time:(\d{2}:\d{2}):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Сохраняю");
    await applyRecurringPolicyDraftTime(ctx, ctx.match[2], ctx.match[1], owner.timezone);
  });

  bot.callbackQuery(/^recurring_draft:custom:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Напиши время, например: «09:30». Для нескольких правил можно написать «оба в 09:30».",
    );
  });

  bot.callbackQuery(/^recurring_draft:cancel:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await finishRecurringPolicyDraftSession({
      userId: owner.id,
      actionId: ctx.match[1],
      status: "cancelled",
      details: { cancelledReason: "user_cancelled" },
    });
    await ctx.answerCallbackQuery("Отменено");
    await ctx.reply("Черновик повторяющихся напоминаний отменён.");
  });

  bot.callbackQuery(/^recurring_dup:(update|new|cancel):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const decision = ctx.match[1] as "update" | "new" | "cancel";
    const session = await getRecurringPolicyDuplicateDecisionSession({
      userId: owner.id,
      actionId: ctx.match[2],
    });
    if (!session) {
      await replyStaleCallback(ctx, { reason: "recurring_duplicate_session_missing" });
      return;
    }
    if (decision === "cancel") {
      await finishRecurringPolicyDuplicateDecision({
        userId: owner.id,
        action: session.action,
        status: "cancelled",
        decision,
      });
      await ctx.answerCallbackQuery("Отменено");
      await ctx.reply("Ок, не создаю дубль.");
      return;
    }
    const draft = await startRecurringPolicyDraftSession({
      userId: owner.id,
      sourceMessageId: session.action.sourceMessageId,
      plan: session.plan,
      policies: session.policies,
      timezone: session.timezone,
      updateExistingPolicyId: decision === "update" ? session.existingPolicyId : null,
    });
    await finishRecurringPolicyDuplicateDecision({
      userId: owner.id,
      action: session.action,
      status: draft ? "completed" : "cancelled",
      decision,
    });
    if (!draft) {
      await ctx.answerCallbackQuery("Не удалось");
      await ctx.reply("Не смог открыть черновик. Ничего не изменил.");
      return;
    }
    await ctx.answerCallbackQuery(decision === "update" ? "Обновим" : "Создам новое");
    await ctx.reply(
      decision === "update"
        ? "Во сколько обновить существующее повторяющееся напоминание?"
        : "Во сколько поставить новое повторяющееся напоминание?",
      { reply_markup: recurringTimeClarificationKeyboard(draft.id, session.policies.length > 1) },
    );
  });

  bot.callbackQuery(/^tr:(rename|rem|create|manual|cancel):([^:]+)(?::(\d+))?$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const decision = ctx.match[1] as "rename" | "rem" | "create" | "manual" | "cancel";
    const actionId = ctx.match[2];
    const index = Number(ctx.match[3] ?? 0);
    const active = await getEventTargetResolutionSession({ userId: owner.id, actionId });
    if (!active) {
      await replyStaleCallback(ctx, { reason: "event_target_resolution_session_missing" });
      return;
    }
    const { action, session } = active;
    if (decision === "cancel") {
      await finishTargetResolutionAction({
        userId: owner.id,
        action,
        status: "cancelled",
        details: { decision, cancelledReason: "user_cancelled" },
      });
      await ctx.answerCallbackQuery("Отменено");
      await ctx.reply("Ок, ничего не изменил.");
      return;
    }
    if (decision === "manual") {
      await ctx.answerCallbackQuery();
      await ctx.reply("Открыл похожие события. Выбери карточку вручную.", {
        reply_markup: entityListKeyboard(
          session.candidates.map((candidate) => ({
            type: "planner_item" as const,
            id: candidate.itemId,
          })),
        ),
      });
      return;
    }
    if (decision === "create") {
      try {
        const created = await createSeparateEventFromSession({
          userId: owner.id,
          proposedEvent: session.proposedEvent,
          sourceMessageId: action.sourceMessageId,
        });
        const calendarFeedback = formatCalendarSyncFeedback(
          await syncItemsToCalendarBestEffort([created.item]),
        );
        await finishTargetResolutionAction({
          userId: owner.id,
          action,
          status: "completed",
          details: {
            decision,
            createdItemId: created.item.id,
            createdPolicyIds: created.reminderResult?.policyIds ?? [],
            createdReminderIds: created.reminderResult?.reminderIds ?? [],
          },
        });
        await ctx.answerCallbackQuery("Создано");
        await ctx.reply(
          [
            "Готово в JARVIS:",
            `• ${created.item.title}`,
            session.proposedEvent.reminders.length
              ? `• Напоминания: ${session.proposedEvent.reminders
                  .map((reminder) => reminder.label)
                  .join(", ")}`
              : null,
            "⚠️ В этом слоте есть похожее событие, оставил оба.",
            calendarFeedback,
          ]
            .filter(Boolean)
            .join("\n"),
          { reply_markup: postCreateTriageKeyboard([created.item]) },
        );
        if (ctx.chat?.id) {
          await refreshDashboardAfterMutation({
            userId: owner.id,
            chatId: ctx.chat.id,
            timezone: owner.timezone,
          });
        }
      } catch (error) {
        await finishTargetResolutionAction({
          userId: owner.id,
          action,
          status: "failed",
          details: {
            decision,
            errorCode: "target_resolution_create_failed",
            safeErrorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        await ctx.answerCallbackQuery("Не удалось");
        await ctx.reply("Не смог безопасно создать отдельное событие. Ничего лишнего не удалял.");
      }
      return;
    }
    const candidate = session.candidates[index];
    const item = candidate ? await itemForCandidate({ userId: owner.id, candidate }) : null;
    if (!item) {
      await finishTargetResolutionAction({
        userId: owner.id,
        action,
        status: "failed",
        details: { decision, errorCode: "target_item_not_found" },
      });
      await ctx.answerCallbackQuery("Не найдено");
      await ctx.reply("Не нашёл выбранное событие. Ничего не изменил.");
      return;
    }
    try {
      const result = await applyReminderSpecsToItem({
        userId: owner.id,
        item,
        reminders: session.proposedEvent.reminders,
        mode: session.proposedEvent.reminderMode,
        timezone: session.proposedEvent.timezone,
        sourceMessageId: action.sourceMessageId,
        title: decision === "rename" ? session.proposedEvent.title : null,
        mutationSource: "event_target_resolution",
      });
      const updatedItem = result.item ?? item;
      const calendarFeedback = formatCalendarSyncFeedback(
        await syncItemsToCalendarBestEffort([updatedItem]),
      );
      await finishTargetResolutionAction({
        userId: owner.id,
        action,
        status: "completed",
        details: {
          decision,
          targetItemId: item.id,
          createdPolicyIds: result.policyIds,
          createdReminderIds: result.reminderIds,
          warnings: result.warnings,
        },
      });
      await ctx.answerCallbackQuery("Готово");
      await ctx.reply(
        [
          "Готово в JARVIS:",
          `• ${updatedItem.title}`,
          session.proposedEvent.reminders.length
            ? `• Напоминания: ${session.proposedEvent.reminders
                .map((reminder) => reminder.label)
                .join(", ")}`
            : null,
          calendarFeedback,
        ]
          .filter(Boolean)
          .join("\n"),
        { reply_markup: itemMenuKeyboard(updatedItem.id) },
      );
      if (ctx.chat?.id) {
        await refreshDashboardAfterMutation({
          userId: owner.id,
          chatId: ctx.chat.id,
          timezone: owner.timezone,
        });
      }
    } catch (error) {
      await finishTargetResolutionAction({
        userId: owner.id,
        action,
        status: "failed",
        details: {
          decision,
          targetItemId: item.id,
          errorCode: "target_resolution_update_failed",
          safeErrorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      await ctx.answerCallbackQuery("Не удалось");
      await ctx.reply("Не смог безопасно обновить событие и напоминания. Ничего не удалял.");
    }
  });

  bot.callbackQuery(/^trrem:(pick|cancel):([^:]+)(?::(\d+))?$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const actionId = ctx.match[2];
    const active = await getReminderTargetResolutionSession({ userId: owner.id, actionId });
    if (!active) {
      await replyStaleCallback(ctx, { reason: "reminder_target_resolution_session_missing" });
      return;
    }
    const { action, session } = active;
    if (ctx.match[1] === "cancel") {
      await finishTargetResolutionAction({
        userId: owner.id,
        action,
        status: "cancelled",
        details: { cancelledReason: "user_cancelled" },
      });
      await ctx.answerCallbackQuery("Отменено");
      await ctx.reply("Ок, напоминания не добавляю.");
      return;
    }
    const index = Number(ctx.match[3] ?? 0);
    const candidate = session.candidates[index];
    const item = candidate ? await itemForCandidate({ userId: owner.id, candidate }) : null;
    const anchor = item?.startAt ?? item?.dueAt ?? null;
    if (!item || !anchor) {
      await finishTargetResolutionAction({
        userId: owner.id,
        action,
        status: "failed",
        details: { errorCode: "target_item_not_found_or_has_no_anchor" },
      });
      await ctx.answerCallbackQuery("Не найдено");
      await ctx.reply("Не нашёл выбранное событие или его время. Ничего не изменил.");
      return;
    }
    const parsed = parseBeforeEventReminderSpecsForAnchor({
      text: session.originalText,
      anchor,
      timezone: item.timezone || owner.timezone,
      now: new Date(),
      allowAbsoluteTimes: false,
      includePast: true,
    });
    const reminders = parsed.reminders.length ? parsed.reminders : session.reminders;
    try {
      const result = await applyReminderSpecsToItem({
        userId: owner.id,
        item,
        reminders,
        mode: session.reminderMode,
        timezone: item.timezone || owner.timezone,
        sourceMessageId: action.sourceMessageId,
        mutationSource: "reminder_target_resolution",
      });
      await finishTargetResolutionAction({
        userId: owner.id,
        action,
        status: "completed",
        details: {
          targetItemId: item.id,
          createdPolicyIds: result.policyIds,
          createdReminderIds: result.reminderIds,
          warnings: result.warnings,
        },
      });
      await ctx.answerCallbackQuery("Готово");
      await ctx.reply(
        [
          "Готово:",
          item.title,
          "",
          "Напоминания:",
          ...reminders.map((reminder) => `• ${reminder.label}`),
        ].join("\n"),
        { reply_markup: itemMenuKeyboard(item.id) },
      );
      if (ctx.chat?.id) {
        await refreshDashboardAfterMutation({
          userId: owner.id,
          chatId: ctx.chat.id,
          timezone: owner.timezone,
        });
      }
    } catch (error) {
      await finishTargetResolutionAction({
        userId: owner.id,
        action,
        status: "failed",
        details: {
          targetItemId: item.id,
          errorCode: "reminder_target_resolution_apply_failed",
          safeErrorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      await ctx.answerCallbackQuery("Не удалось");
      await ctx.reply("Не смог безопасно добавить напоминания. Ничего не удалял.");
    }
  });

  bot.callbackQuery(/^calendar:retry:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    if (!item) {
      await ctx.answerCallbackQuery("Событие не найдено");
      return;
    }
    await ctx.answerCallbackQuery("Повторяю синхронизацию");
    const result = await retryCalendarItem(item);
    await ctx.reply(
      result.status === "synced"
        ? `Календарь синхронизирован: ${item.title}`
        : `Событие сохранено в JARVIS. Календарь: ${result.errorClass ?? result.status}; повторю автоматически.`,
    );
    await refreshAfterCallback(ctx, item.id);
  });

  bot.callbackQuery(/^calendar:debug:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    if (!item) {
      await ctx.answerCallbackQuery("Событие не найдено");
      return;
    }
    const [sync, job] = await Promise.all([
      getItemCalendarSyncState(item.id, "yandex_calendar"),
      getCalendarSyncJobForItem(item.id, "yandex_calendar"),
    ]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        `itemId: ${item.id}`,
        `status: ${sync?.status ?? "unknown"}`,
        `errorClass: ${sync?.lastError ?? "none"}`,
        `durationMs: ${sync?.durationMs ?? "unknown"}`,
        `externalIdPresent: ${Boolean(sync?.externalId)}`,
        `retryJobStatus: ${job?.status ?? "none"}`,
        `retryAttemptCount: ${job?.attemptCount ?? 0}`,
      ].join("\n"),
    );
  });

  bot.callbackQuery(/^calendar:disable:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    if (!item) {
      await ctx.answerCallbackQuery("Событие не найдено");
      return;
    }
    await Promise.all([
      markGoogleCalendarSync({
        item,
        status: "disabled",
        lastError: null,
        provider: "yandex_calendar",
      }),
      disableCalendarSyncForItem(item.id, "yandex_calendar"),
    ]);
    await ctx.answerCallbackQuery("Синхронизация отключена");
    await refreshAfterCallback(ctx, item.id);
  });

  bot.callbackQuery("tz:ok", async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Готово");
    await ctx.reply(`Оставил часовой пояс: ${owner.timezone}`);
  });

  bot.callbackQuery("tz:edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши команду в формате: /settings Europe/Moscow");
  });

  bot.callbackQuery(/^pa:ok:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const pendingActionId = ctx.match[1];
    await ctx.answerCallbackQuery("Сохраняю");
    let result;
    try {
      result = await confirmPendingActionInDb({
        pendingActionId,
        telegramUserId: String(ctx.from.id),
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        await ctx.reply(error.message);
        return;
      }
      throw error;
    }

    if (result.status === "created") {
      const calendarResults = await syncItemsToCalendarBestEffort([result.item]);
      const syncLine = formatCalendarSyncFeedback(calendarResults);

      await ctx.reply(
        [formatCreatedItem(result.item, result.reminders.length), syncLine]
          .filter(Boolean)
          .join("\n\n"),
        {
          reply_markup: postCreateTriageKeyboard([result.item]),
        },
      );
      const allItems = await listManageableItems(owner.id, 300);
      const conflict = detectPlanConflicts(allItems).find(
        (entry) => entry.first.id === result.item.id || entry.second.id === result.item.id,
      );
      if (conflict) {
        await ctx.reply(
          ["⚠️ Накладка", "", formatConflictLine(conflict, owner.timezone), "", "Что делаем?"].join(
            "\n",
          ),
          { reply_markup: conflictKeyboard(conflict.first.id, conflict.second.id) },
        );
      }
      await refreshAfterCallback(ctx);
      return;
    }

    if (result.status === "already_confirmed") {
      await ctx.reply("Эта запись уже была подтверждена.");
      return;
    }
    if (result.status === "cancelled") {
      await ctx.reply("Это предложение уже отменено.");
      return;
    }
    await ctx.reply("Предложение истекло или не найдено. Пришли формулировку заново.");
  });

  bot.callbackQuery(/^plan:confirm:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Сохраняю план");
    let result;
    try {
      result = await commitStoredActionPlan({
        actionPlanId: ctx.match[1],
        userId: owner.id,
        timezone: owner.timezone,
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        await ctx.reply(error.message);
        return;
      }
      throw error;
    }
    if (result.status === "committed") {
      const calendarResults = await syncItemsToCalendarBestEffort(result.items);
      const calendarFeedback = formatCalendarSyncFeedback(calendarResults);
      await ctx.reply(
        [
          formatCommittedPlanSummary({
            items: result.items,
            reminderCount: result.reminders.length + result.policyReminderIds.length,
            reminderPolicies: result.policies,
            timezone: owner.timezone,
          }),
          calendarFeedback,
        ]
          .filter(Boolean)
          .join("\n\n"),
        result.items.length ? { reply_markup: postCreateTriageKeyboard(result.items) } : undefined,
      );
      const allItems = await listManageableItems(owner.id, 300);
      const createdIds = new Set(result.items.map((item) => item.id));
      const conflict = detectPlanConflicts(allItems).find(
        (entry) => createdIds.has(entry.first.id) || createdIds.has(entry.second.id),
      );
      if (conflict) {
        await ctx.reply(
          ["⚠️ Накладка", "", formatConflictLine(conflict, owner.timezone), "", "Что делаем?"].join(
            "\n",
          ),
          { reply_markup: conflictKeyboard(conflict.first.id, conflict.second.id) },
        );
      }
      await refreshAfterCallback(ctx);
      return;
    }
    if (result.status === "already_committed") {
      await ctx.reply("Этот план уже сохранён.");
      return;
    }
    await ctx.reply("План уже неактуален или отменён. Пришли формулировку заново.");
  });

  bot.callbackQuery(/^plan:cancel:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Отменено");
    await cancelStoredActionPlan({ actionPlanId: ctx.match[1], userId: owner.id });
    await ctx.reply("Ок, этот план не сохраняю.");
  });

  bot.callbackQuery(/^plan:edit:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Пришли исправленную формулировку одним сообщением. Старый план не меняю автоматически.",
    );
  });

  bot.callbackQuery(/^reset:confirm:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Очищаю активный план");
    const result = await executeActivePlanReset({
      userId: owner.id,
      actionId: ctx.match[1],
      mode: "all",
    });
    await ctx.reply(
      result.status === "completed"
        ? `Готово. Архивировал активных записей: ${result.items.length}. История, память и recurring-настройки сохранены.`
        : "Этот запрос на очистку уже обработан.",
      result.status === "completed" ? { reply_markup: undoActionKeyboard() } : undefined,
    );
    if (result.status === "completed") await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reset:garbage:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Убираю мусор и тесты");
    const result = await executeActivePlanReset({
      userId: owner.id,
      actionId: ctx.match[1],
      mode: "garbage",
    });
    await ctx.reply(
      result.status === "completed"
        ? `Готово. Архивировал тестовых и ошибочных записей: ${result.items.length}.`
        : "Этот запрос на очистку уже обработан.",
      result.status === "completed" ? { reply_markup: undoActionKeyboard() } : undefined,
    );
    if (result.status === "completed") await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reset:cancel:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await cancelActivePlanReset({ userId: owner.id, actionId: ctx.match[1] });
    await ctx.answerCallbackQuery("Отменено");
    await ctx.reply("Очистку отменил. Ничего не изменено.");
  });

  bot.callbackQuery("reset:show", async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery();
    const result = await renderScheduleViewTool({
      userId: owner.id,
      timezone: owner.timezone,
      sourceMessageId: ctx.dbMessageId,
      scope: "full",
    });
    await ctx.reply(result.reply);
    if (result.affectedItemIds.length) await refreshAfterCallback(ctx);
  });

  bot.callbackQuery("agent:undo", async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Откатываю");
    const result = await undoLastActionTool({
      userId: owner.id,
      timezone: owner.timezone,
      sourceMessageId: ctx.dbMessageId,
    });
    await ctx.reply(result.reply);
    if (result.affectedItemIds.length) await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^safe_mutation:(confirm|cancel):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = ctx.match[1];
    const result =
      mode === "confirm"
        ? await confirmNumberedMutationTool({
            userId: owner.id,
            timezone: owner.timezone,
            sourceMessageId: ctx.dbMessageId,
            actionId: ctx.match[2],
          })
        : await cancelNumberedMutationTool({
            userId: owner.id,
            timezone: owner.timezone,
            sourceMessageId: ctx.dbMessageId,
            actionId: ctx.match[2],
          });
    await ctx.answerCallbackQuery(mode === "confirm" ? "Применяю" : "Отменено");
    await ctx.reply(
      result.reply,
      result.replyMarkup ? { reply_markup: result.replyMarkup } : undefined,
    );
    if (mode === "confirm") {
      const tasks = await renderTaskViewTool({
        userId: owner.id,
        timezone: owner.timezone,
        sourceMessageId: ctx.dbMessageId,
      });
      await ctx.reply(tasks.reply, { reply_markup: tasks.replyMarkup });
      await refreshAfterCallback(ctx);
    }
  });

  bot.callbackQuery(/^pa:no:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Отменено");
    await cancelPendingAction(owner.id, ctx.match[1]);
    await ctx.reply("Ок, не сохраняю.");
  });

  bot.callbackQuery(/^pa:edit:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Пришли исправленную формулировку одним сообщением. Старое предложение не сохраняю.",
    );
  });

  bot.callbackQuery(/^done:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const existing = await getPlannerItemById(owner.id, ctx.match[1]);
    if (existing && requiresCampaignCompletionClarification(existing)) {
      await ctx.answerCallbackQuery("Нужно уточнение");
      await ctx.reply(`«${existing.title}» ещё в будущем. Что именно произошло?`, {
        reply_markup: campaignCompletionGuardKeyboard(existing.id),
      });
      return;
    }
    await ctx.answerCallbackQuery("Отмечаю");
    const item = await markPlannerItemCompleted(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    if (item) {
      await cancelPendingPromptRenagsForTarget({
        userId: owner.id,
        targetItemId: item.id,
        reason: "item_completed",
      }).catch(() => undefined);
    }
    if (item) {
      await writeAudit({
        userId: owner.id,
        action: "assistant.planner_mutation",
        entityType: "planner_item",
        entityId: item.id,
        details: { mutationSource: "policy_completion", operation: "complete" },
      });
    }
    if (!item) await ctx.reply("Не нашёл задачу.");
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^manage:reschedule:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery(item ? "Жду новое время" : "Не найдено");
    if (!item) {
      await ctx.reply("Не нашёл эту запись.");
      return;
    }
    await startItemEditSession({
      userId: owner.id,
      itemId: item.id,
      mode: "time",
      sourceMessageId: ctx.dbMessageId,
      sourceTelegramMessageId: ctx.callbackQuery?.message?.message_id ?? null,
    });
    await ctx.reply(
      `Меняю время у «${item.title}». Напиши новое время одним сообщением: «на понедельник в 8 утра» или «15.06 на 8 утра».`,
    );
  });

  bot.callbackQuery(/^manage:edit:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery(item ? "Жду правку" : "Не найдено");
    if (item) {
      await startItemEditSession({
        userId: owner.id,
        itemId: item.id,
        mode: "general",
        sourceMessageId: ctx.dbMessageId,
        sourceTelegramMessageId: ctx.callbackQuery?.message?.message_id ?? null,
      });
    }
    await ctx.reply(
      item
        ? `Что изменить в «${item.title}»? Напиши одним сообщением, например: «Изменить на "Новый текст", поставь на понедельник в 8 утра, напоминай раз в час, пока не сделаю».`
        : "Не нашёл эту запись.",
    );
  });

  bot.callbackQuery(/^pinned:(show|edit|unpin|delete):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const action = ctx.match[1] as "show" | "edit" | "unpin" | "delete";
    const item = await getPlannerItemById(owner.id, ctx.match[2]);
    if (!item || !isPinnedContextNote(item)) {
      await ctx.answerCallbackQuery("Заметка не найдена");
      return;
    }
    if (action === "show") {
      await ctx.answerCallbackQuery("Показываю в плане");
      await refreshAfterCallback(ctx, item.id);
      return;
    }
    if (action === "edit") {
      await startItemEditSession({
        userId: owner.id,
        itemId: item.id,
        mode: "general",
        sourceMessageId: ctx.dbMessageId,
        sourceTelegramMessageId: ctx.callbackQuery?.message?.message_id ?? null,
      });
      await writeAudit({
        userId: owner.id,
        action: "assistant.pinned_context_note_opened",
        entityType: "planner_item",
        entityId: item.id,
        details: {
          category: item.metadata?.pinnedCategory ?? null,
          operation: "edit_session_started",
        },
      }).catch(() => undefined);
      await ctx.answerCallbackQuery("Жду правку");
      await ctx.reply(`Что изменить в закреплённой заметке «${item.title}»? Напиши одним сообщением.`);
      return;
    }
    if (action === "unpin") {
      const updated = await updatePlannerItemDetails({
        userId: owner.id,
        itemId: item.id,
        metadata: {
          pinnedContext: false,
          unpinnedAt: new Date().toISOString(),
          unpinnedBy: "owner_callback",
        },
      });
      await writeAudit({
        userId: owner.id,
        action: "assistant.pinned_context_note_updated",
        entityType: "planner_item",
        entityId: item.id,
        details: {
          category: item.metadata?.pinnedCategory ?? null,
          operation: "unpin",
        },
      }).catch(() => undefined);
      await ctx.answerCallbackQuery(updated ? "Открепил" : "Не найдено");
      await refreshAfterCallback(ctx, item.id);
      return;
    }
    const deleted = await cancelPlannerItem(owner.id, item.id);
    await writeAudit({
      userId: owner.id,
      action: "assistant.pinned_context_note_deleted",
      entityType: "planner_item",
      entityId: item.id,
      details: {
        category: item.metadata?.pinnedCategory ?? null,
        operation: "delete",
      },
    }).catch(() => undefined);
    await ctx.answerCallbackQuery(deleted ? "Удалил" : "Не найдено");
    await refreshAfterCallback(ctx, item.id);
  });

  bot.callbackQuery(/^item_edit:confirm:(.+)$/, async (ctx) => {
    await confirmItemEditPreview(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^item_edit:multi_mode:(add|replace):(.+)$/, async (ctx) => {
    await chooseMultiReminderMode(ctx, ctx.match[2], ctx.match[1] as "add" | "replace");
  });

  bot.callbackQuery(/^iemm:([ar]):(.+)$/, async (ctx) => {
    await chooseMultiReminderMode(ctx, ctx.match[2], ctx.match[1] === "a" ? "add" : "replace");
  });

  bot.callbackQuery(/^item_edit:cancel:(.+)$/, async (ctx) => {
    await cancelItemEditPreview(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^manage:delete:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const policies = await listReminderPoliciesForItem(owner.id, ctx.match[1]);
    const repeatPolicy = policies.find(
      (policy) =>
        policy.status === "active" &&
        ["recurring", "long_term", "interval_window", "nag_until_ack"].includes(policy.policyType),
    );
    if (repeatPolicy) {
      await ctx.answerCallbackQuery("Нужно выбрать");
      await ctx.reply("Удалить только правило напоминания или всю задачу вместе с правилом?", {
        reply_markup: repeatPolicyDeleteKeyboard(repeatPolicy.id, ctx.match[1]),
      });
      return;
    }
    const deleted = await deletePlannerItemEverywhere({
      userId: owner.id,
      itemId: ctx.match[1],
      source: "user_delete_callback",
    });
    const item = deleted?.item ?? null;
    await ctx.answerCallbackQuery(item ? "Удалено" : "Не найдено");
    if (!item) await ctx.reply("Не нашёл эту запись.");
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^past_review:(keep|archive):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const action = ctx.match[1] as "keep" | "archive";
    const itemId = ctx.match[2];
    const item =
      action === "keep"
        ? await updatePlannerItemDetails({
            userId: owner.id,
            itemId,
            metadata: {
              pastReviewOverride: {
                keepInPlan: true,
                setAt: new Date().toISOString(),
                reason: "user_kept",
              },
            },
          })
        : await updatePlannerItemDetails({
            userId: owner.id,
            itemId,
            visibility: "history",
            metadata: {
              archivedFromPastReviewAt: new Date().toISOString(),
              archivedBy: "past_review_action",
            },
          });
    await ctx.answerCallbackQuery(item ? "Готово" : "Не найдено");
    await ctx.reply(
      item
        ? action === "keep"
          ? "Оставил событие в плане."
          : "Убрал событие в архив."
        : "Не нашёл событие. Ничего не изменил.",
    );
    if (item && ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
  });

  bot.callbackQuery(/^policy:cancel_rule:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      status: "cancelled",
    });
    await ctx.answerCallbackQuery(updated ? "Правило удалено" : "Не найдено");
    await refreshAfterCallback(ctx, updated?.itemId);
  });

  bot.callbackQuery(/^policy:cancel_all:(.+):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const policy = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      status: "cancelled",
    });
    const item = await cancelPlannerItem(owner.id, ctx.match[2]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    await ctx.answerCallbackQuery(policy || item ? "Удалено" : "Не найдено");
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^pca:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const sourcePolicy = await getReminderPolicyById(ctx.match[1]);
    const itemId = sourcePolicy?.userId === owner.id ? sourcePolicy.itemId : null;
    const policy = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      status: "cancelled",
    });
    const item = itemId ? await cancelPlannerItem(owner.id, itemId) : null;
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    await ctx.answerCallbackQuery(policy || item ? "Удалено" : "Не найдено");
    await refreshAfterCallback(ctx, item?.id ?? itemId);
  });

  bot.callbackQuery("tasks:open", async (ctx) => {
    const owner = requireOwner(ctx);
    const result = await renderTaskViewTool({
      userId: owner.id,
      timezone: owner.timezone,
      sourceMessageId: ctx.dbMessageId,
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(result.reply, { reply_markup: result.replyMarkup });
  });

  bot.callbackQuery("tasks:delete_help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Напиши номера из текущего списка, например: «удалить 5, 6, 7». Сначала покажу preview.",
    );
  });

  bot.callbackQuery("tasks:done_help", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Напиши номера из текущего списка, например: «готово 2 и 4».");
  });

  bot.callbackQuery("tasks:review_old", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Открываю старое и неразобранное. Используй /review или /history для подробного разбора.",
    );
  });

  bot.callbackQuery("tasks:archive", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Архив и завершённые записи доступны в /history.");
  });

  bot.callbackQuery("reminders:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Напиши правило одним сообщением: что напоминать, когда и нужно ли повторять до подтверждения.",
    );
  });

  bot.callbackQuery("triage:done", async (ctx) => {
    await ctx.answerCallbackQuery("Оставил как есть");
  });

  bot.callbackQuery(/^triage:(priority|reminders):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "priority") {
      await ctx.reply("Открой нужный пункт по номеру и выбери «Важность».");
      return;
    }
    await ctx.reply("Открой нужный пункт по номеру и выбери «Добавить напоминание».");
  });

  bot.callbackQuery("conflict:keep", async (ctx) => {
    await ctx.answerCallbackQuery("Оставил оба");
  });

  bot.callbackQuery(/^conflict:open:(.+):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const cards = await Promise.all(
      [ctx.match[1], ctx.match[2]].map((id) =>
        renderEntityCard({
          userId: owner.id,
          timezone: owner.timezone,
          ref: { type: "planner_item", id },
        }),
      ),
    );
    await ctx.answerCallbackQuery();
    for (const card of cards) {
      if (card) await ctx.reply(card.text, { reply_markup: card.keyboard });
    }
  });

  bot.callbackQuery("manage:bulk_time", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Напиши, каким задачам поставить время. Например: Зумы РГ в 12:00, созвон НХЛ в 16:30.",
    );
  });

  bot.callbackQuery("manage:bulk_reminder", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Напиши, по каким задачам и когда напомнить. Например: напомни про рилзы ЧМ через 2 часа.",
    );
  });

  bot.callbackQuery(/^event_reminder:ack:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const source = await getReminderByIdForUser({ userId: owner.id, reminderId });
    await ackReminderOccurrence({ userId: owner.id, reminderId });
    await acknowledgePolicyReminder(reminderId);
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? null,
      reason: "event_reminder_acknowledged",
    }).catch(() => undefined);
    await writeAudit({
      userId: owner.id,
      action: "assistant.event_reminder_acknowledged",
      entityType: "reminder",
      entityId: reminderId,
      details: {
        plannerItemId: source?.plannerItemId ?? null,
        policyId: source?.policyId ?? null,
        eventCompleted: false,
      },
    }).catch(() => undefined);
    await ctx.answerCallbackQuery("Помню");
    await refreshAfterCallback(ctx, source?.plannerItemId);
  });

  bot.callbackQuery(/^event_reminder:again:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const source = await getReminderByIdForUser({ userId: owner.id, reminderId });
    const result = await scheduleSmartExtraEventReminder({
      userId: owner.id,
      reminderId,
      now: new Date(),
    });
    if (result.status === "scheduled") {
      await cancelPendingPromptRenagsForTarget({
        userId: owner.id,
        targetReminderId: reminderId,
        targetItemId: source?.plannerItemId ?? null,
        reason: "event_extra_scheduled",
      }).catch(() => undefined);
      await ctx.answerCallbackQuery("Поставил");
      await ctx.reply(
        `Ок, ещё раз напомню ${formatRuWeekdayDateTime(result.scheduledAt, owner.timezone)}.`,
      );
    } else if (result.status === "needs_choice") {
      const text = "Событие уже близко. Выбери, через сколько ещё напомнить.";
      await ctx.answerCallbackQuery();
      await ctx.reply(text, {
        reply_markup: eventReminderExtraChoiceKeyboard(reminderId, result.optionsMinutes),
      });
      await recordPendingPromptRenag({
        userId: owner.id,
        promptType: "event_extra_reminder_choice",
        text,
        targetReminderId: reminderId,
        targetItemId: source?.plannerItemId ?? null,
        now: new Date(),
      }).catch(() => undefined);
    } else {
      await ctx.answerCallbackQuery("Событие уже слишком близко");
      await ctx.reply(
        "Не ставлю автоматическое дополнительное напоминание: событие уже слишком близко или началось.",
      );
    }
    await refreshAfterCallback(ctx, source?.plannerItemId);
  });

  bot.callbackQuery(/^event_reminder:extra:([^:]+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const minutes = Number(ctx.match[2]);
    const source = await getReminderByIdForUser({ userId: owner.id, reminderId });
    const result = await scheduleManualEventReminderSnooze({
      userId: owner.id,
      reminderId,
      minutes,
      now: new Date(),
    });
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? null,
      reason: "event_extra_choice_answered",
    }).catch(() => undefined);
    if (result.status === "scheduled") {
      await ctx.answerCallbackQuery("Поставил");
      await ctx.reply(
        `Ок, напомню ${formatRuWeekdayDateTime(result.scheduledAt, owner.timezone)}.`,
      );
    } else {
      await ctx.answerCallbackQuery("Уже поздно");
      await ctx.reply("Не ставлю это напоминание: оно уже не успеет сработать до начала события.");
    }
    await refreshAfterCallback(ctx, source?.plannerItemId);
  });

  bot.callbackQuery(/^event_reminder:snooze:([^:]+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const minutes = Number(ctx.match[2]);
    const source = await getReminderByIdForUser({ userId: owner.id, reminderId });
    const result = await scheduleManualEventReminderSnooze({
      userId: owner.id,
      reminderId,
      minutes,
      now: new Date(),
    });
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? null,
      targetPolicyId: source?.policyId ?? null,
      reason: "event_reminder_snoozed",
    }).catch(() => undefined);
    await writeAudit({
      userId: owner.id,
      action: "assistant.event_reminder_snooze_attempt",
      entityType: "reminder",
      entityId: reminderId,
      details: {
        minutes,
        plannerItemId: source?.plannerItemId ?? null,
        policyId: source?.policyId ?? null,
        status: result.status,
        scheduledAt: result.status === "scheduled" ? result.scheduledAt.toISOString() : null,
        eventTimeChanged: false,
      },
    }).catch(() => undefined);
    if (result.status === "scheduled") {
      await ctx.answerCallbackQuery("Отложил");
      await ctx.reply(
        `Ок, напомню ${formatRuWeekdayDateTime(result.scheduledAt, owner.timezone)}. Время события не менял.`,
      );
    } else {
      await ctx.answerCallbackQuery("Уже поздно");
      await ctx.reply("Не откладываю: новое напоминание попало бы после начала события.");
    }
    await refreshAfterCallback(ctx, source?.plannerItemId);
  });

  bot.callbackQuery(/^event_reminder:stop:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const source = await getReminderByIdForUser({ userId: owner.id, reminderId });
    if (source?.plannerItemId) {
      await cancelItemReminders(owner.id, source.plannerItemId);
      await stopPoliciesForItem(owner.id, source.plannerItemId);
    }
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? null,
      reason: "event_reminders_stopped",
    }).catch(() => undefined);
    await writeAudit({
      userId: owner.id,
      action: "assistant.event_reminders_stopped",
      entityType: "reminder",
      entityId: reminderId,
      details: {
        plannerItemId: source?.plannerItemId ?? null,
        eventCancelled: false,
      },
    }).catch(() => undefined);
    await ctx.answerCallbackQuery("Больше не напомню");
    await ctx.reply(
      "Ок, больше не буду напоминать об этом событии. Само событие осталось в плане.",
    );
    await refreshAfterCallback(ctx, source?.plannerItemId);
  });

  bot.callbackQuery(/^reminder:ack:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const now = new Date();
    const reminderId = ctx.match[1];
    const [policyRow, source] = await Promise.all([
      getPolicyForReminder(reminderId),
      getReminderByIdForUser({ userId: owner.id, reminderId }),
    ]);
    await ackReminderForToday({
      userId: owner.id,
      reminderId,
      dayStart: startOfLocalDay(now, owner.timezone),
      dayEnd: endOfLocalDay(now, owner.timezone),
    });
    await acknowledgePolicyReminder(reminderId);
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? policyRow?.policy.itemId ?? null,
      targetPolicyId: source?.policyId ?? policyRow?.policy.id ?? null,
      reason: "reminder_acknowledged",
    }).catch(() => undefined);
    if (policyRow?.policy.itemId && policyRow.policy.metadata?.stopOnItemComplete === true) {
      const existingItem = await getPlannerItemById(owner.id, policyRow.policy.itemId);
      if (existingItem && isEventLikePlannerItem(existingItem)) {
        await writeAudit({
          userId: owner.id,
          action: "assistant.event_reminder_ack_guarded",
          entityType: "planner_item",
          entityId: existingItem.id,
          details: { mutationSource: "policy_completion", operationSkipped: "complete_event" },
        }).catch(() => undefined);
      } else {
        const item = await markPlannerItemCompleted(owner.id, policyRow.policy.itemId);
        if (item) {
          await cancelItemReminders(owner.id, item.id);
          await stopPoliciesForItem(owner.id, item.id);
          await writeAudit({
            userId: owner.id,
            action: "assistant.planner_mutation",
            entityType: "planner_item",
            entityId: item.id,
            details: { mutationSource: "policy_completion", operation: "complete" },
          });
        }
      }
    }
    await ctx.answerCallbackQuery("Готово");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:snooze:([^:]+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const minutes = Number(ctx.match[2]);
    const source = await getReminderByIdForUser({
      userId: owner.id,
      reminderId,
    });
    if (ctx.match[1] === "tomorrow") {
      const row = await getPolicyForReminder(reminderId);
      const item = row?.policy.itemId
        ? await getPlannerItemById(owner.id, row.policy.itemId)
        : null;
      if (isTodayUntilDoneReminderPolicy(row?.policy) || isTodayUntilDonePlannerItem(item)) {
        await ctx.answerCallbackQuery();
        await ctx.reply(
          [
            "Эта задача была на сегодня.",
            "Перенести задачу на завтра или только отложить напоминание?",
          ].join("\n"),
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Перенести задачу",
                    callback_data: `r:cmt:${reminderId}`,
                  },
                  {
                    text: "Только напоминание",
                    callback_data: `r:sto:${reminderId}`,
                  },
                ],
                [{ text: "Отмена", callback_data: "dashboard:refresh" }],
              ],
            },
          },
        );
        return;
      }
    }
    const snoozed = await snoozeReminder({
      userId: owner.id,
      reminderId,
      minutes,
    });
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? null,
      targetPolicyId: source?.policyId ?? null,
      reason: "reminder_snoozed",
    }).catch(() => undefined);
    await writeAudit({
      userId: owner.id,
      action: "assistant.reminder_snooze_attempt",
      entityType: "reminder",
      entityId: reminderId,
      details: {
        minutes,
        sourceFound: Boolean(source),
        sourceStatus: source?.status ?? null,
        sourcePolicyId: source?.policyId ?? null,
        sourcePlannerItemId: source?.plannerItemId ?? null,
        succeeded: Boolean(snoozed),
        scheduledAt: snoozed?.scheduledAt?.toISOString() ?? null,
        snoozeTarget: snoozed
          ? String((snoozed as { snoozeTarget?: unknown }).snoozeTarget ?? "unknown")
          : null,
        fallbackUsed: Boolean(
          (snoozed as { snoozeFallbackUsed?: unknown } | null)?.snoozeFallbackUsed,
        ),
      },
    }).catch(() => undefined);
    await ctx.answerCallbackQuery(snoozed ? "Отложил" : "Окно уже закончилось");
    if (snoozed) {
      const row = await getPolicyForReminder(reminderId);
      const until = formatRuWeekdayDateTime(snoozed.scheduledAt, owner.timezone);
      await ctx.reply(
        `Ок, отложил «${row?.policy.title ?? "напоминание"}» до ${until}. До этого времени не буду напоминать по этой задаче.`,
      );
    } else await ctx.reply("Не удалось отложить это напоминание.");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:snooze_(evening|tomorrow):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[2];
    const nowLocal = DateTime.now().setZone(owner.timezone);
    const target =
      ctx.match[1] === "evening"
        ? nowLocal.set({ hour: 19, minute: 0, second: 0, millisecond: 0 })
        : nowLocal.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const future = target > nowLocal ? target : target.plus({ days: 1 });
    const minutes = Math.max(1, Math.ceil(future.diff(nowLocal, "minutes").minutes));
    const source = await getReminderByIdForUser({
      userId: owner.id,
      reminderId,
    });
    const snoozed = await snoozeReminder({
      userId: owner.id,
      reminderId,
      minutes,
    });
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? null,
      targetPolicyId: source?.policyId ?? null,
      reason: "reminder_snoozed",
    }).catch(() => undefined);
    await writeAudit({
      userId: owner.id,
      action: "assistant.reminder_snooze_attempt",
      entityType: "reminder",
      entityId: reminderId,
      details: {
        preset: ctx.match[1],
        minutes,
        sourceFound: Boolean(source),
        sourceStatus: source?.status ?? null,
        sourcePolicyId: source?.policyId ?? null,
        sourcePlannerItemId: source?.plannerItemId ?? null,
        succeeded: Boolean(snoozed),
        scheduledAt: snoozed?.scheduledAt?.toISOString() ?? null,
        snoozeTarget: snoozed
          ? String((snoozed as { snoozeTarget?: unknown }).snoozeTarget ?? "unknown")
          : null,
        fallbackUsed: Boolean(
          (snoozed as { snoozeFallbackUsed?: unknown } | null)?.snoozeFallbackUsed,
        ),
      },
    }).catch(() => undefined);
    await ctx.answerCallbackQuery(snoozed ? "Отложил" : "Окно уже закончилось");
    if (snoozed) {
      const row = await getPolicyForReminder(reminderId);
      const until = formatRuWeekdayDateTime(snoozed.scheduledAt, owner.timezone);
      await ctx.reply(
        `Ок, отложил «${row?.policy.title ?? "напоминание"}» до ${until}. До этого времени не буду напоминать по этой задаче.`,
      );
    } else await ctx.reply("Не удалось отложить это напоминание.");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:snooze_eod:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const [source, row] = await Promise.all([
      getReminderByIdForUser({ userId: owner.id, reminderId }),
      getPolicyForReminder(reminderId),
    ]);
    const now = new Date();
    const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(owner.timezone);
    const untilDone = isUntilDoneSnoozeTarget(row?.policy ?? null, source ?? null);
    if (untilDone) {
      const tomorrowMorning = nowLocal
        .plus({ days: 1 })
        .set({ hour: 8, minute: 0, second: 0, millisecond: 0 })
        .toUTC()
        .toJSDate();
      const previousNextReminderAt = row?.policy.nextFireAt?.toISOString() ?? null;
      const snoozed = await snoozeReminderUntil({
        userId: owner.id,
        reminderId,
        snoozedUntil: tomorrowMorning,
        now,
        reason: "button_end_of_day",
      });
      await cancelPendingPromptRenagsForTarget({
        userId: owner.id,
        targetReminderId: reminderId,
        targetItemId: source?.plannerItemId ?? row?.policy.itemId ?? null,
        targetPolicyId: source?.policyId ?? row?.policy.id ?? null,
        reason: "reminder_snoozed_until_tomorrow",
      }).catch(() => undefined);
      await writeAudit({
        userId: owner.id,
        action: "assistant.until_done_snoozed_until_tomorrow",
        entityType: "reminder",
        entityId: reminderId,
        details: {
          targetItemId: source?.plannerItemId ?? row?.policy.itemId ?? null,
          targetPolicyId: source?.policyId ?? row?.policy.id ?? null,
          source: "button_end_of_day",
          previousNextReminderAt,
          nextReminderAt: tomorrowMorning.toISOString(),
          timezone: owner.timezone,
          succeeded: Boolean(snoozed),
        },
      }).catch(() => undefined);
      await ctx.answerCallbackQuery(snoozed ? "До завтра" : "Не удалось отложить");
      await ctx.reply(
        row?.policy.metadata?.openEndedUntilDone === true
          ? "Ок, больше не трогаю сегодня.\nПродолжу завтра в 08:00."
          : "Ок, больше не трогаю сегодня.\nВернусь завтра в 08:00.",
      );
      await refreshAfterCallback(ctx, source?.plannerItemId ?? row?.policy.itemId);
      return;
    }
    const endOfDay = nowLocal
      .set({ hour: 23, minute: 59, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
    const target =
      row?.policy.endsAt && row.policy.endsAt < endOfDay
        ? row.policy.endsAt
        : endOfDay;
    const minutes = Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 60_000));
    const snoozed =
      minutes > 0
        ? await snoozeReminder({ userId: owner.id, reminderId, minutes })
        : null;
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? row?.policy.itemId ?? null,
      targetPolicyId: source?.policyId ?? row?.policy.id ?? null,
      reason: "reminder_snoozed_end_of_day",
    }).catch(() => undefined);
    await writeAudit({
      userId: owner.id,
      action: "assistant.reminder_snooze_attempt",
      entityType: "reminder",
      entityId: reminderId,
      details: {
        preset: "end_of_day",
        minutes,
        succeeded: Boolean(snoozed),
        scheduledAt: snoozed?.scheduledAt?.toISOString() ?? null,
      },
    }).catch(() => undefined);
    await ctx.answerCallbackQuery(snoozed ? "Отложил до конца дня" : "Окно уже закончилось");
    if (snoozed) {
      await ctx.reply(
        `Ок, напомню снова в ${DateTime.fromJSDate(snoozed.scheduledAt, { zone: "utc" }).setZone(owner.timezone).toFormat("HH:mm")}.`,
      );
    }
    await refreshAfterCallback(ctx, source?.plannerItemId ?? row?.policy.itemId);
  });

  bot.callbackQuery(/^(?:reminder:confirm_move_tomorrow|r:cmt):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const row = await getPolicyForReminder(reminderId);
    const item = row?.policy.itemId
      ? await getPlannerItemById(owner.id, row.policy.itemId)
      : null;
    if (!row?.policy || !item) {
      await ctx.answerCallbackQuery("Не нашёл задачу");
      return;
    }
    const nowLocal = DateTime.now().setZone(owner.timezone);
    const start = nowLocal
      .plus({ days: 1 })
      .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
    const end = nowLocal
      .plus({ days: 1 })
      .set({ hour: 23, minute: 59, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
    await updatePlannerItemDetails({
      userId: owner.id,
      itemId: item.id,
      dueAt: end,
      metadata: {
        timeScope: "tomorrow",
        untilDone: true,
        movedFromTodayAt: new Date().toISOString(),
        moveReason: "owner_confirmed_tomorrow_from_today_until_done",
      },
    });
    const updatedPolicy = await updateReminderPolicy({
      userId: owner.id,
      policyId: row.policy.id,
      startsAt: start,
      endsAt: end,
      nextFireAt: start,
      snoozedUntil: null,
      snoozeScope: null,
      status: "active",
      metadata: {
        timeScope: "tomorrow",
        movedFromTodayAt: new Date().toISOString(),
        moveReason: "owner_confirmed_tomorrow_from_today_until_done",
      },
    });
    await cancelPendingRemindersForPolicy({
      userId: owner.id,
      policyId: row.policy.id,
      from: new Date(0),
    });
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: item.id,
      targetPolicyId: row.policy.id,
      reason: "reminder_moved_tomorrow",
    }).catch(() => undefined);
    if (updatedPolicy) await materializeNextPolicyReminder(updatedPolicy, start, { now: new Date() });
    await ctx.answerCallbackQuery("Перенёс");
    await ctx.reply("Ок, перенёс задачу на завтра и поставил первое напоминание на утро.");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^(?:reminder:snooze_tomorrow_only|r:sto):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const reminderId = ctx.match[1];
    const row = await getPolicyForReminder(reminderId);
    if (!row?.policy) {
      await ctx.answerCallbackQuery("Не нашёл напоминание");
      return;
    }
    const tomorrowMorning = DateTime.now()
      .setZone(owner.timezone)
      .plus({ days: 1 })
      .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
    await cancelPendingRemindersForPolicy({
      userId: owner.id,
      policyId: row.policy.id,
      from: new Date(0),
    });
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: row.policy.itemId,
      targetPolicyId: row.policy.id,
      reason: "reminder_snoozed_tomorrow_only",
    }).catch(() => undefined);
    await updateReminderPolicy({
      userId: owner.id,
      policyId: row.policy.id,
      snoozedUntil: tomorrowMorning,
      snoozeScope: "policy",
      metadata: {
        lastSnoozedAt: new Date().toISOString(),
        snoozedUntil: tomorrowMorning.toISOString(),
        todayTaskDueKept: true,
      },
    });
    await ctx.answerCallbackQuery("Отложил только напоминание");
    await ctx.reply("Ок, задачу оставил в сегодняшнем плане, а напоминание отложил.");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:edit:(.+)$/, async (ctx) => {
    const row = await getPolicyForReminder(ctx.match[1]);
    await ctx.answerCallbackQuery();
    if (!row?.policy.itemId) {
      await ctx.reply("У этой карточки нет связанной задачи для изменения policy.");
      return;
    }
    await ctx.reply("Как изменить напоминание?", {
      reply_markup: reminderPolicyMenuKeyboard(row.policy.itemId),
    });
  });

  bot.callbackQuery(/^reminder:stop_prompt:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const row = await getPolicyForReminder(ctx.match[1]);
    if (!row || row.policy.userId !== owner.id) {
      await ctx.answerCallbackQuery("Напоминание не найдено");
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      row.policy.recurrenceRule
        ? "Остановить повторяющееся правило? Сама задача останется в плане."
        : "Остановить это напоминание? Сама задача останется в плане.",
      {
        reply_markup: new InlineKeyboard()
          .text("Да, остановить", `policy:cancel_rule:${row.policy.id}`)
          .text("Отмена", `policy:open:${row.policy.id}`),
      },
    );
  });

  bot.callbackQuery(/^reminder:skip:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const now = new Date();
    const reminderId = ctx.match[1];
    const source = await getReminderByIdForUser({ userId: owner.id, reminderId });
    await ackReminderForToday({
      userId: owner.id,
      reminderId,
      dayStart: startOfLocalDay(now, owner.timezone),
      dayEnd: endOfLocalDay(now, owner.timezone),
    });
    await acknowledgePolicyReminder(reminderId, true);
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetReminderId: reminderId,
      targetItemId: source?.plannerItemId ?? null,
      targetPolicyId: source?.policyId ?? null,
      reason: "reminder_skipped",
    }).catch(() => undefined);
    await ctx.answerCallbackQuery("Пропущено");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^reminder:(pause|delete):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const action = ctx.match[1];
    const row = await getPolicyForReminder(ctx.match[2]);
    if (row) {
      await updateReminderPolicy({
        policyId: row.policy.id,
        userId: owner.id,
        status: action === "pause" ? "paused" : "cancelled",
        nextFireAt: null,
      });
      await cancelPendingPromptRenagsForTarget({
        userId: owner.id,
        targetReminderId: ctx.match[2],
        targetItemId: row.policy.itemId,
        targetPolicyId: row.policy.id,
        reason: action === "pause" ? "reminder_policy_paused" : "reminder_policy_deleted",
      }).catch(() => undefined);
    }
    await ctx.answerCallbackQuery(action === "pause" ? "Поставил на паузу" : "Удалил");
    await refreshAfterCallback(ctx, row?.policy.itemId);
  });

  bot.callbackQuery(/^item:stop_recurring:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await stopRecurringReminders(owner.id, ctx.match[1]);
    await stopPoliciesForItem(owner.id, ctx.match[1]);
    await cancelPendingPromptRenagsForTarget({
      userId: owner.id,
      targetItemId: ctx.match[1],
      reason: "recurring_item_stopped",
    }).catch(() => undefined);
    await ctx.answerCallbackQuery("Остановил");
    await refreshAfterCallback(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^tentative:happened:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await markPlannerItemCompleted(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    await ctx.answerCallbackQuery(item ? "Отметил" : "Не найдено");
    await ctx.reply(
      item
        ? `Понял, событие было: ${item.title}. Можешь надиктовать итоги, я выделю задачи.`
        : "Не нашёл это tentative-событие.",
    );
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^tentative:skipped:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await cancelPlannerItem(owner.id, ctx.match[1]);
    if (item) await cancelItemReminders(owner.id, item.id);
    if (item) await stopPoliciesForItem(owner.id, item.id);
    await ctx.answerCallbackQuery(item ? "Отмечено" : "Не найдено");
    await ctx.reply(
      item ? `Ок, отмечаю как не состоялось: ${item.title}` : "Не нашёл это tentative-событие.",
    );
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^tentative:reschedule:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "На когда перенести? Напиши новой фразой, например: перенеси этот созвон на завтра 12:30.",
    );
  });

  bot.callbackQuery(/^tentative:notes:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Надиктуй или напиши итоги созвона, я разложу их на задачи и заметки.");
  });

  bot.callbackQuery(/^dashboard:item:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    if (!item) {
      await ctx.reply("Эта запись уже не активна.");
      await refreshAfterCallback(ctx);
      return;
    }
    const card = await renderEntityCard({
      userId: owner.id,
      timezone: owner.timezone,
      ref: { type: "planner_item", id: item.id },
    });
    const sent = await ctx.reply(card?.text ?? `${item.title}\n\nЧто делаем?`, {
      reply_markup: card?.keyboard ?? itemMenuKeyboard(item.id),
    });
    if (ctx.chat?.id) {
      await registerBotMessage({
        userId: owner.id,
        chatId: String(ctx.chat.id),
        messageId: sent.message_id,
        purpose: "item_menu",
        relatedItemId: item.id,
      });
    }
  });

  bot.callbackQuery("dashboard:refresh", async (ctx) => {
    await ctx.answerCallbackQuery("Обновляю");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery("dashboard:add", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Что добавить в план? Напиши или надиктуй одним сообщением.");
  });

  bot.callbackQuery("dashboard:reminders", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyCenter(ctx, "active");
  });

  bot.callbackQuery("dashboard:longterm", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyCenter(ctx, "longterm");
  });

  bot.callbackQuery("dashboard:cleanup", async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Показываю preview");
    if (!ctx.chat?.id) return;
    const preview = await renderCleanupPreview({
      userId: owner.id,
      chatId: String(ctx.chat.id),
    });
    await ctx.reply(preview.text, { reply_markup: preview.keyboard });
  });

  bot.callbackQuery(
    /^cleanup:preview:(messages|completed|drafts|broken|all):chat:(.+)$/,
    async (ctx) => {
      const owner = requireOwner(ctx);
      const category = ctx.match[1] as CleanupCategory;
      const chatId = ctx.match[2];
      await ctx.answerCallbackQuery("Показываю preview");
      const preview = await renderCleanupPreview({
        userId: owner.id,
        chatId,
        category,
      });
      await ctx.reply(preview.text, { reply_markup: preview.keyboard });
    },
  );

  bot.callbackQuery(/^cleanup:confirm:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const actionId = ctx.match[1];
    const session = await getCleanupPreviewSession({ userId: owner.id, actionId });
    if (!session) {
      await ctx.answerCallbackQuery("Preview устарел");
      return;
    }
    await ctx.answerCallbackQuery("Выполняю подтверждённую очистку");
    let deletedMessages = 0;
    if (session.category === "messages" || session.category === "all") {
      const results = await cleanupTransientMessages({
        userId: owner.id,
        chatId: session.chatId,
      });
      deletedMessages = results.filter(Boolean).length;
    }
    const result = await applyCleanupPreviewSession({ userId: owner.id, actionId });
    await ctx.reply(
      [
        "Очистка завершена.",
        `Сообщения: ${deletedMessages}`,
        `Архивировано выполненных: ${result?.archivedCompleted ?? 0}`,
        `Отменено черновиков: ${result?.cancelledDrafts ?? 0}`,
        `Отключено сломанных напоминаний: ${result?.cancelledBrokenPolicies ?? 0}`,
        "Яндекс.Календарь: 0 изменений.",
      ].join("\n"),
    );
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^cleanup:cancel:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await cancelCleanupPreviewSession({ userId: owner.id, actionId: ctx.match[1] });
    await ctx.answerCallbackQuery("Отменено");
    await ctx.reply("Очистку не выполняю.");
  });

  bot.callbackQuery("cleanup:cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Отменено");
    await ctx.reply("Ок, очистку не выполняю.");
  });

  bot.callbackQuery(/^completed:page:(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const view = await renderCompletedItemsView({
      userId: owner.id,
      timezone: owner.timezone,
      page: Number(ctx.match[1]),
    });
    await ctx.answerCallbackQuery("Открываю");
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  });

  bot.callbackQuery(/^completed:open:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const card = await renderEntityCard({
      userId: owner.id,
      timezone: owner.timezone,
      ref: { type: "history_item", id: ctx.match[1] },
    });
    await ctx.answerCallbackQuery(card ? "Открываю" : "Запись не найдена");
    if (card) await editOrReply(ctx, card.text, card.keyboard);
  });

  bot.callbackQuery(/^completed:restore:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const restored = await restoreCompletedItem({ userId: owner.id, itemId: ctx.match[1] });
    await ctx.answerCallbackQuery(restored ? "Вернул" : "Не найдено");
    if (restored) {
      await ctx.reply(
        `Вернул в задачи: «${restored.title}». Старые завершённые или просроченные напоминания не включал.`,
      );
      await refreshAfterCallback(ctx, restored.id);
    }
  });

  bot.callbackQuery(/^completed:archive:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const archived = await archiveCompletedItem({ userId: owner.id, itemId: ctx.match[1] });
    await ctx.answerCallbackQuery(archived ? "Оставил в архиве" : "Не найдено");
    if (archived)
      await ctx.reply("Оставил запись в выполненных/архиве. Активные напоминания не включал.");
  });

  bot.callbackQuery(/^repair_policies:(preview|apply|manual)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = ctx.match[1];
    await ctx.answerCallbackQuery();
    if (mode === "manual") {
      await ctx.reply(
        "Для ручного архивирования используй явную команду удаления задачи. Очистка Telegram-карточек planner items не меняет.",
      );
      return;
    }
    if (mode === "preview") {
      const preview = await previewReminderPolicyRepair({
        userId: owner.id,
        timezone: owner.timezone,
      });
      await ctx.reply(
        preview.groups.length
          ? preview.groups
              .flatMap((group) => [
                `${group.group}: ${group.action}`,
                ...group.titles.map((title) => `• ${title}`),
              ])
              .join("\n")
          : "Legacy reminder groups не найдены.",
      );
      return;
    }
    const result = await applyReminderPolicyRepair({
      userId: owner.id,
      timezone: owner.timezone,
    });
    await ctx.reply(
      `Конвертация завершена: ${result.repairedItems.length} items, ${result.policyIds.length} policies.`,
    );
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^item:results:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Надиктуй или напиши, что было. Я выделю итоги и новые задачи.");
  });

  bot.callbackQuery(/^item:remind:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyEditorMessage(
      ctx,
      "Как напоминать?",
      reminderPolicyMenuKeyboard(ctx.match[1]),
      ctx.match[1],
    );
  });

  bot.callbackQuery(
    /^policy_menu:(root|once|before|interval|schedule|until|multi|quiet|category|custom):(.+)$/,
    async (ctx) => {
      const section = ctx.match[1];
      const itemId = ctx.match[2];
      await ctx.answerCallbackQuery();
      if (section === "root") {
        await sendPolicyEditorMessage(
          ctx,
          "Как напоминать?",
          reminderPolicyMenuKeyboard(itemId),
          itemId,
        );
        return;
      }
      if (section === "once") {
        await sendPolicyEditorMessage(
          ctx,
          "Когда напомнить один раз?",
          oneTimeReminderMenuKeyboard(itemId),
          itemId,
        );
        return;
      }
      if (section === "before") {
        await sendPolicyEditorMessage(
          ctx,
          "За сколько до события?",
          beforeEventReminderMenuKeyboard(itemId),
          itemId,
        );
        return;
      }
      if (section === "multi") {
        await startMultiReminderSetupSession({
          userId: requireOwner(ctx).id,
          itemId,
          sourceMessageId: ctx.dbMessageId,
          sourceTelegramMessageId: ctx.callbackQuery?.message?.message_id ?? null,
        });
        await sendPolicyEditorMessage(
          ctx,
          "Напиши набор напоминаний одним сообщением. Например: «в 7:00 и 7:30» или «за день в 9 утра, за 2 часа и за 30 минут».",
          undefined,
          itemId,
        );
        return;
      }
      if (section === "interval") {
        await sendPolicyEditorMessage(
          ctx,
          "Какой интервал?",
          intervalReminderMenuKeyboard(itemId),
          itemId,
        );
        return;
      }
      if (section === "schedule") {
        await sendPolicyEditorMessage(
          ctx,
          "Какое расписание?",
          scheduleReminderMenuKeyboard(itemId),
          itemId,
        );
        return;
      }
      const prompts = {
        until: "Напиши интервал и границу: например, каждые 30 минут до 18:00, пока не отмечу.",
        quiet:
          "Напиши правило: не пиши ночью / можно ночью / только утром / только в рабочее время.",
        category:
          "Напиши категорию: content, meeting, training, health, car, home, finance, documents, people или project.",
        custom: "Опиши своё правило одним сообщением. OpenAI разберёт его в typed reminder policy.",
      } as const;
      if (section === "until") {
        await startReminderPolicyEditSession({
          userId: requireOwner(ctx).id,
          itemId,
          section,
          sourceMessageId: ctx.dbMessageId,
        });
      }
      await sendPolicyEditorMessage(
        ctx,
        prompts[section as keyof typeof prompts],
        undefined,
        itemId,
      );
    },
  );

  bot.callbackQuery(/^policy_once:(.+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const minutes = Number(ctx.match[2]);
    const created = await createQuickPolicy({
      userId: owner.id,
      itemId: ctx.match[1],
      timezone: owner.timezone,
      policyType: "one_time",
      fireAt: new Date(Date.now() + minutes * 60 * 1000),
    });
    await ctx.answerCallbackQuery(created ? "Настроено" : "Не удалось");
    if (!created) await ctx.reply("Не нашёл активную задачу.");
    await refreshAfterCallback(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^policy_once_(evening|tomorrow):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const local = DateTime.now().setZone(owner.timezone);
    let target =
      ctx.match[1] === "evening"
        ? local.set({ hour: 19, minute: 0, second: 0, millisecond: 0 })
        : local.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    if (target <= local) target = target.plus({ days: 1 });
    const created = await createQuickPolicy({
      userId: owner.id,
      itemId: ctx.match[2],
      timezone: owner.timezone,
      policyType: "one_time",
      fireAt: target.toUTC().toJSDate(),
    });
    await ctx.answerCallbackQuery(created ? "Настроено" : "Не удалось");
    if (!created) await ctx.reply("Не нашёл задачу.");
    await refreshAfterCallback(ctx, ctx.match[2]);
  });

  bot.callbackQuery(/^policy_before:(.+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    const anchor = item?.startAt ?? item?.dueAt;
    const minutes = Number(ctx.match[2]);
    const fireAt = anchor ? new Date(anchor.getTime() - minutes * 60 * 1000) : null;
    const created =
      item && fireAt && fireAt > new Date()
        ? await createQuickPolicy({
            userId: owner.id,
            itemId: item.id,
            timezone: item.timezone,
            policyType: "before_event",
            fireAt,
            metadata: { minutesBefore: minutes, relativeLabel: formatBeforeEventOffset(minutes) },
          })
        : null;
    await ctx.answerCallbackQuery(created ? "Настроено" : "Время уже прошло");
    if (!created) await ctx.reply("Не могу поставить это напоминание в будущее.");
    await refreshAfterCallback(ctx, item?.id);
  });

  bot.callbackQuery(/^policy_(interval|schedule|before_multi):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const section = ctx.match[1];
    const itemId = ctx.match[2];
    await ctx.answerCallbackQuery();
    if (section === "before_multi") {
      await startMultiReminderSetupSession({
        userId: owner.id,
        itemId,
        sourceMessageId: ctx.dbMessageId,
        sourceTelegramMessageId: ctx.callbackQuery?.message?.message_id ?? null,
      });
    }
    await sendPolicyEditorMessage(
      ctx,
      section === "interval"
        ? "До какого времени повторять и нужно ли остановить после отметки? Напиши одним сообщением."
        : section === "schedule"
          ? "Во сколько присылать это регулярное напоминание? Напиши одним сообщением."
          : "Настрою пару напоминаний. Напиши: «в 7:00 и 7:30» или «за день и за час до события».",
      undefined,
      itemId,
    );
  });

  bot.callbackQuery(/^prep:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      item
        ? `Что подготовить к «${item.title}»? Напиши или надиктуй, я предложу задачу на подтверждение.`
        : "Не нашёл встречу.",
    );
  });

  bot.callbackQuery(/^checklist:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      item
        ? [
            `Чек-лист к «${item.title}»:`,
            "• цель встречи",
            "• список вопросов",
            "• нужные материалы",
            "• решение, которое нужно получить",
          ].join("\n")
        : "Не нашёл встречу.",
    );
  });

  bot.callbackQuery(/^policy:list:(active|today|soon|distant|longterm|paused)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyCenter(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^policy:open:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyCard(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^policy:priority:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyEditorMessage(
      ctx,
      "Выбери приоритет 1-5:",
      priorityEditorKeyboard("policy", ctx.match[1]),
    );
  });

  bot.callbackQuery(/^policy:frequency:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyEditorMessage(ctx, "Выбери частоту:", policyFrequencyKeyboard(ctx.match[1]));
  });

  bot.callbackQuery(/^policy:set_priority:(.+):([1-5])$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      basePriority: Number(ctx.match[2]),
    });
    await ctx.answerCallbackQuery(updated ? `Приоритет ${ctx.match[2]}` : "Policy не найдена");
    if (updated) await sendPolicyCard(ctx, updated.id);
  });

  bot.callbackQuery(/^policy:set_interval:(.+):(\d+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[1],
      intervalMinutes: Number(ctx.match[2]),
    });
    await ctx.answerCallbackQuery(updated ? "Частота обновлена" : "Policy не найдена");
    if (updated) await sendPolicyCard(ctx, updated.id);
  });

  bot.callbackQuery(/^policy:(pause|resume|cancel):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const action = ctx.match[1];
    const updated = await editReminderPolicy({
      userId: owner.id,
      policyId: ctx.match[2],
      status: action === "resume" ? "active" : action === "pause" ? "paused" : "cancelled",
    });
    await ctx.answerCallbackQuery(
      updated
        ? action === "resume"
          ? "Возобновлено"
          : action === "pause"
            ? "На паузе"
            : "Удалено"
        : "Policy не найдена",
    );
    if (updated?.status === "cancelled") await sendPolicyCenter(ctx, "active");
    else if (updated) await sendPolicyCard(ctx, updated.id);
  });

  bot.callbackQuery(/^item:priority:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyEditorMessage(
      ctx,
      "Выбери видимую важность:",
      priorityEditorKeyboard("item", ctx.match[1]),
    );
  });

  bot.callbackQuery(/^item_policy:cancel:([^:]+):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const itemId = ctx.match[1];
    const policyId = ctx.match[2];
    const current = (await listReminderPoliciesForItem(owner.id, itemId, 100)).find(
      (policy) =>
        policy.id === policyId &&
        policy.status === "active" &&
        policy.policyType === "before_event",
    );
    const policy = current
      ? await updateReminderPolicy({
          userId: owner.id,
          policyId,
          status: "cancelled",
          nextFireAt: null,
          metadata: {
            cancelledFromItemCardAt: new Date().toISOString(),
            cancelReason: "individual_before_event_reminder_removed",
          },
        })
      : null;
    if (policy) {
      await cancelPendingRemindersForPolicy({ userId: owner.id, policyId });
    }
    await ctx.answerCallbackQuery(policy ? "Напоминание удалено" : "Не найдено");
    await refreshAfterCallback(ctx, itemId);
  });

  bot.callbackQuery(/^ipc:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const sourcePolicy = await getReminderPolicyById(ctx.match[1]);
    const itemId = sourcePolicy?.userId === owner.id ? sourcePolicy.itemId : null;
    const current =
      sourcePolicy &&
      sourcePolicy.userId === owner.id &&
      sourcePolicy.status === "active" &&
      sourcePolicy.policyType === "before_event"
        ? sourcePolicy
        : null;
    const policy = current
      ? await updateReminderPolicy({
          userId: owner.id,
          policyId: current.id,
          status: "cancelled",
          nextFireAt: null,
          metadata: {
            cancelledFromItemCardAt: new Date().toISOString(),
            cancelReason: "individual_before_event_reminder_removed",
            callbackAlias: "ipc",
          },
        })
      : null;
    if (policy) {
      await cancelPendingRemindersForPolicy({ userId: owner.id, policyId: policy.id });
    }
    await ctx.answerCallbackQuery(policy ? "Напоминание удалено" : "Не найдено");
    await refreshAfterCallback(ctx, itemId);
  });

  bot.callbackQuery(/^item_policy:cancel_all_before:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const itemId = ctx.match[1];
    const policies = (await listReminderPoliciesForItem(owner.id, itemId, 100)).filter(
      (policy) => policy.status === "active" && policy.policyType === "before_event",
    );
    for (const policy of policies) {
      await cancelPendingRemindersForPolicy({ userId: owner.id, policyId: policy.id });
      await updateReminderPolicy({
        userId: owner.id,
        policyId: policy.id,
        status: "cancelled",
        nextFireAt: null,
        metadata: {
          cancelledFromItemCardAt: new Date().toISOString(),
          cancelReason: "all_before_event_reminders_removed",
        },
      });
    }
    await ctx.answerCallbackQuery(`Удалено: ${policies.length}`);
    await refreshAfterCallback(ctx, itemId);
  });

  bot.callbackQuery(/^ipcab:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const itemId = ctx.match[1];
    const policies = (await listReminderPoliciesForItem(owner.id, itemId, 100)).filter(
      (policy) => policy.status === "active" && policy.policyType === "before_event",
    );
    for (const policy of policies) {
      await cancelPendingRemindersForPolicy({ userId: owner.id, policyId: policy.id });
      await updateReminderPolicy({
        userId: owner.id,
        policyId: policy.id,
        status: "cancelled",
        nextFireAt: null,
        metadata: {
          cancelledFromItemCardAt: new Date().toISOString(),
          cancelReason: "all_before_event_reminders_removed",
          callbackAlias: "ipcab",
        },
      });
    }
    await ctx.answerCallbackQuery(`Удалено: ${policies.length}`);
    await refreshAfterCallback(ctx, itemId);
  });

  bot.callbackQuery(/^item:marker:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendPolicyEditorMessage(
      ctx,
      "Как показывать ❗ у этой записи?",
      persistentMarkerKeyboard(ctx.match[1]),
    );
  });

  bot.callbackQuery(/^item:set_marker:(.+):(auto|show|hide)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const mode = ctx.match[2] as "auto" | "show" | "hide";
    const updated = await updatePlannerItemDetails({
      userId: owner.id,
      itemId: ctx.match[1],
      metadata: { persistentMarkerMode: mode },
    });
    await ctx.answerCallbackQuery(updated ? "Маркер обновлён" : "Запись не найдена");
    if (updated) {
      await ctx.reply(markerModeConfirmation(updated.title, mode));
    }
    await refreshAfterCallback(ctx, updated?.id);
  });

  bot.callbackQuery(
    /^deadline_reminder:(soon|morning|2h|1h|30m|none|custom):(.+)$/,
    async (ctx) => {
      const owner = requireOwner(ctx);
      const preset = ctx.match[1] as "soon" | "morning" | "2h" | "1h" | "30m" | "none" | "custom";
      const item = await getPlannerItemById(owner.id, ctx.match[2]);
      if (!item?.dueAt || item.status !== "active") {
        await ctx.answerCallbackQuery("Задача не найдена");
        return;
      }
      if (preset === "none") {
        await ctx.answerCallbackQuery("Без напоминания");
        await ctx.reply("Хорошо, напоминание не добавляю.");
        return;
      }
      if (preset === "custom") {
        await ctx.answerCallbackQuery();
        await ctx.reply("Как напомнить о дедлайне?", {
          reply_markup: reminderPolicyMenuKeyboard(item.id),
        });
        return;
      }
      const fireAt = buildDeadlineReminderFireAt({
        dueAt: item.dueAt,
        timezone: item.timezone || owner.timezone,
        preset,
      });
      const created = fireAt
        ? await createQuickPolicy({
            userId: owner.id,
            itemId: item.id,
            timezone: owner.timezone,
            policyType: "before_event",
            fireAt,
          })
        : null;
      await ctx.answerCallbackQuery(created ? "Напоминание добавлено" : "Это время уже прошло");
      if (created && fireAt) {
        await ctx.reply(
          `Напоминание: ${formatRuWeekdayDateTime(fireAt, item.timezone || owner.timezone)}`,
        );
      } else {
        await ctx.reply("Не могу поставить выбранное напоминание в будущее до дедлайна.");
      }
      await refreshAfterCallback(ctx, item.id);
    },
  );

  bot.callbackQuery(
    /^item:set_importance:(.+):(none|important|very_important|auto)$/,
    async (ctx) => {
      const owner = requireOwner(ctx);
      const mode = ctx.match[2];
      const priority = mode === "very_important" ? 5 : mode === "important" ? 4 : 3;
      const updated = await updatePlannerItemDetails({
        userId: owner.id,
        itemId: ctx.match[1],
        priority,
        metadata: {
          basePriority: priority,
          importanceMode: mode === "important" || mode === "very_important" ? "manual" : mode,
        },
      });
      await ctx.answerCallbackQuery(updated ? "Важность обновлена" : "Запись не найдена");
      if (updated)
        await updatePoliciesPriorityForItem({ userId: owner.id, itemId: updated.id, priority });
      await refreshAfterCallback(ctx, updated?.id);
    },
  );

  bot.callbackQuery(/^isi:(n|i|vi|a):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const modeMap = {
      n: "none",
      i: "important",
      vi: "very_important",
      a: "auto",
    } as const;
    const mode = modeMap[ctx.match[1] as keyof typeof modeMap];
    const priority = mode === "very_important" ? 5 : mode === "important" ? 4 : 3;
    const updated = await updatePlannerItemDetails({
      userId: owner.id,
      itemId: ctx.match[2],
      priority,
      metadata: {
        basePriority: priority,
        importanceMode: mode === "important" || mode === "very_important" ? "manual" : mode,
      },
    });
    await ctx.answerCallbackQuery(updated ? "Важность обновлена" : "Запись не найдена");
    if (updated)
      await updatePoliciesPriorityForItem({ userId: owner.id, itemId: updated.id, priority });
    await refreshAfterCallback(ctx, updated?.id);
  });

  bot.callbackQuery(/^item:more:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, "Дополнительные действия", itemMoreKeyboard(ctx.match[1]));
  });

  bot.callbackQuery(/^item:set_priority:(.+):([1-5])$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await setPlannerItemManualPriority({
      userId: owner.id,
      itemId: ctx.match[1],
      priority: Number(ctx.match[2]),
    });
    if (updated) {
      await updatePoliciesPriorityForItem({
        userId: owner.id,
        itemId: updated.id,
        priority: Number(ctx.match[2]),
      });
    }
    await ctx.answerCallbackQuery(updated ? `Приоритет ${ctx.match[2]}` : "Запись не найдена");
    await refreshAfterCallback(ctx, updated?.id);
  });

  bot.callbackQuery(
    /^entity:open:(planner_item|reminder_policy|campaign|campaign_item|external|history_item|legacy_orphan):(.+)$/,
    async (ctx) => {
      const owner = requireOwner(ctx);
      const card = await renderEntityCard({
        userId: owner.id,
        timezone: owner.timezone,
        ref: {
          type: (ctx.match[1] === "external"
            ? "external_calendar_event"
            : ctx.match[1]) as EntityRefType,
          id: ctx.match[2],
        },
      });
      await ctx.answerCallbackQuery(card ? "Открываю" : "Запись не найдена");
      if (card) await editOrReply(ctx, card.text, card.keyboard);
    },
  );

  bot.callbackQuery(/^external:delete_prompt:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editOrReply(
      ctx,
      "Удалить событие из Яндекс.Календаря тоже?",
      externalCalendarDeleteKeyboard(ctx.match[1]),
    );
  });

  bot.callbackQuery(/^external:hide:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const hidden = await hideExternalCalendarEvent(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery(hidden ? "Скрыто в JARVIS" : "Событие не найдено");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^external:delete_everywhere:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const event = await getExternalCalendarEventById(owner.id, ctx.match[1]);
    if (!event) {
      await ctx.answerCallbackQuery("Событие не найдено");
      return;
    }
    await deleteYandexCalendarObject(event.calendarObjectUrl);
    await deleteExternalCalendarEventCache(owner.id, event.id);
    await ctx.answerCallbackQuery("Удалено из Яндекс.Календаря");
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^external:edit:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const event = await getExternalCalendarEventById(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    if (!event) return;
    if (!event.isRecurring) {
      await startExternalCalendarEditSession({
        userId: owner.id,
        eventId: event.id,
        sourceTelegramMessageId: ctx.callbackQuery.message?.message_id,
      });
    }
    await ctx.reply(
      event.isRecurring
        ? "Это повторяющееся событие. Сейчас поддерживается изменение или удаление всей серии; изменение одного повтора будет добавлено отдельно."
        : `Что изменить в «${event.summary}»? Напиши новое название и/или время одним сообщением.`,
    );
  });

  bot.callbackQuery(/^external:recurring_info:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Это повторяющаяся серия. Сейчас можно удалить всю серию или скрыть её в JARVIS. Изменение отдельного повтора пока не поддерживается.",
    );
  });

  bot.callbackQuery(/^entity:item_policies:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const policies = await listReminderPoliciesForItem(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      policies.length
        ? policies
            .map((policy, index) => `${index + 1}. ${policy.title} — ${policy.status}`)
            .join("\n")
        : "Связанных напоминаний пока нет.",
      policies.length
        ? {
            reply_markup: entityListKeyboard(
              policies.map((policy) => ({ type: "reminder_policy", id: policy.id })),
            ),
          }
        : undefined,
    );
  });

  bot.callbackQuery(/^campaign:prep_done:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const updated = await markCampaignPreparationDone(owner.id, ctx.match[1]);
    await ctx.answerCallbackQuery(updated ? "Подготовку отметил" : "Запись не найдена");
    if (updated) {
      await ctx.reply("Подготовка отмечена. Само будущее событие осталось активным.");
    }
  });

  bot.callbackQuery(/^campaign:event_passed:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const item = await getPlannerItemById(owner.id, ctx.match[1]);
    const result = item
      ? await completeCampaignEventAndActivateNext({ userId: owner.id, item })
      : null;
    if (result?.completed) {
      await cancelItemReminders(owner.id, result.completed.id);
      await stopPoliciesForItem(owner.id, result.completed.id);
    }
    await ctx.answerCallbackQuery(result?.completed ? "Событие завершено" : "Запись не найдена");
    await refreshAfterCallback(ctx, result?.activated?.id ?? result?.completed?.id);
  });

  bot.callbackQuery(/^campaign:(activate|pause|resume|cancel|priority):(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const action = ctx.match[1];
    if (action === "priority") {
      await ctx.answerCallbackQuery();
      await ctx.reply(
        "Напиши новую важность кампании одним сообщением, например: «Central Park очень важно».",
      );
      return;
    }
    const result = await updateCampaignState({
      userId: owner.id,
      campaignGroup: ctx.match[2],
      action: action as "activate" | "pause" | "resume" | "cancel",
    });
    await ctx.answerCallbackQuery("Готово");
    await ctx.reply(
      `Кампания обновлена: ${result.itemCount} элементов, ${result.policyCount} политик.`,
    );
    await refreshAfterCallback(ctx);
  });

  bot.callbackQuery(/^forget:(.+)$/, async (ctx) => {
    const owner = requireOwner(ctx);
    await ctx.answerCallbackQuery("Удаляю");
    const deleted = await deleteMemoryForUser(owner.id, ctx.match[1]);
    await ctx.reply(deleted ? "Удалил из памяти." : "Не нашёл такую запись памяти.");
  });
}

async function sendPolicyCenter(ctx: BotContext, scope: string) {
  const owner = requireOwner(ctx);
  const center = await renderReminderControlCenter({
    userId: owner.id,
    timezone: owner.timezone,
    scope,
  });
  await sendPolicyEditorMessage(ctx, center.text, center.keyboard);
}

async function sendPolicyCard(ctx: BotContext, policyId: string) {
  const owner = requireOwner(ctx);
  const card = await renderReminderPolicyCard({
    userId: owner.id,
    policyId,
    timezone: owner.timezone,
  });
  if (!card) {
    await ctx.answerCallbackQuery("Policy не найдена");
    return;
  }
  await sendPolicyEditorMessage(ctx, card.text, card.keyboard);
}

async function sendPolicyEditorMessage(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
  relatedItemId?: string | null,
) {
  const owner = requireOwner(ctx);
  if (!ctx.chat?.id) return;
  await cleanupPolicyEditorMessages({ userId: owner.id, chatId: String(ctx.chat.id) });
  const sent = keyboard ? await ctx.reply(text, { reply_markup: keyboard }) : await ctx.reply(text);
  await registerBotMessage({
    userId: owner.id,
    chatId: String(ctx.chat.id),
    messageId: sent.message_id,
    purpose: "policy_editor",
    relatedItemId: relatedItemId ?? undefined,
  });
}

function markerModeConfirmation(title: string, mode: "auto" | "show" | "hide") {
  if (mode === "hide") return `Ок, скрыл ❗ у «${title}».`;
  if (mode === "show") return `Ок, буду показывать ❗ у «${title}».`;
  return "Ок, маркер ❗ будет появляться автоматически.";
}

async function editOrReply(ctx: BotContext, text: string, keyboard: InlineKeyboard) {
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard });
      return;
    } catch {
      // Telegram rejects edits when the message is no longer editable or unchanged.
    }
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

async function refreshAfterCallback(ctx: BotContext, relatedItemId?: string | null) {
  const owner = requireOwner(ctx);
  if (!ctx.chat?.id) return;
  await cleanupAfterCallback({
    userId: owner.id,
    chatId: String(ctx.chat.id),
    messageId: ctx.callbackQuery?.message?.message_id,
    relatedItemId,
  });
  await refreshDashboardAfterMutation({
    userId: owner.id,
    chatId: ctx.chat.id,
    timezone: owner.timezone,
  });
}

function isUntilDoneSnoozeTarget(
  policy: { policyType?: string | null; requireAck?: boolean; metadata?: Record<string, unknown> } | null,
  reminder: { repeatUntilAck?: boolean; type?: string | null; payload?: Record<string, unknown> } | null,
) {
  return Boolean(
    policy?.policyType === "nag_until_ack" ||
      policy?.metadata?.stopCondition === "until_done" ||
      policy?.metadata?.untilDone === true ||
      policy?.metadata?.untilDoneCarryover === true ||
      policy?.metadata?.openEndedUntilDone === true ||
      (policy?.requireAck === true && reminder?.repeatUntilAck === true) ||
      reminder?.payload?.endOfDaySnoozeSemantic === "resume_tomorrow_morning",
  );
}

async function createQuickPolicy(params: {
  userId: string;
  itemId: string;
  timezone: string;
  policyType: "one_time" | "before_event";
  fireAt: Date;
  metadata?: Record<string, unknown>;
}) {
  const item = await getPlannerItemById(params.userId, params.itemId);
  if (!item || item.status !== "active") return null;
  const policy = await createReminderPolicyIfMissing({
    userId: params.userId,
    itemId: item.id,
    title: item.title,
    category: params.policyType === "before_event" ? "pre_event" : (item.category ?? "today_focus"),
    policyType: params.policyType,
    timezone: item.timezone || params.timezone,
    startsAt: params.fireAt,
    nextFireAt: params.fireAt,
    requireAck: false,
    catchUpMode: "one_immediate_then_resume",
    idempotencyKey: `telegram-menu:${params.policyType}:${item.id}:${params.fireAt.toISOString()}`,
    metadata: {
      mutationSource: "user_natural_language",
      configuredFrom: "reminder_policy_menu",
      ...(params.metadata ?? {}),
    },
  });
  await materializeNextPolicyReminder(policy, params.fireAt);
  return policy;
}

function formatBeforeEventOffset(minutes: number) {
  if (minutes === 10) return "за десять минут";
  if (minutes === 30) return "за полчаса";
  if (minutes === 60) return "за час";
  if (minutes === 120) return "за 2 часа";
  if (minutes === 1440) return "за день";
  return "заранее";
}
