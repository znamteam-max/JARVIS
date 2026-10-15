import { DateTime } from "luxon";

import {
  createActiveDashboard,
  getActiveDashboard,
  markDashboardStatus,
} from "@/db/queries/liveDashboards";
import { listLegacyReminderLikeItems, listPinnedContextNotes } from "@/db/queries/items";
import { listActiveRemindersForItems } from "@/db/queries/reminders";
import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import { logger } from "@/lib/logger";
import { classifyTimelineItem, getBasePriority } from "@/domain/timelineClassification";
import { importanceMarker, visibleImportanceMarker } from "@/domain/importance";
import type { EntityRef } from "@/domain/entityRefs";
import { buildUserTimelineView } from "@/services/userTimeline";
import { listCalendarSyncStatesForUser } from "@/db/queries/googleCalendar";
import { formatRuItemsRequireDecision } from "@/lib/ruPlural";
import { rememberTaskView } from "@/agent/state/taskViewState";
import { detectPlanConflicts, formatConflictLine } from "@/services/planConflicts";
import { reconcileActiveReminderPolicies } from "@/services/reminderPolicyReconciler";
import {
  formatDedupedBeforeEventPolicies,
  formatEventFollowupReminderLines,
  formatHumanReminderPolicy,
  formatItemReminderPolicyLines,
  isReminderPolicyReviewRequired,
  isPersistentReminderPolicy,
} from "@/domain/reminderPolicyPresentation";
import { shouldShowPersistentMarker } from "@/domain/persistentMarker";
import { formatRuWeekdayDateTime } from "@/domain/dateTime";
import { formatDeadlineDateTime } from "@/domain/deadlineSemantics";
import { writeAudit } from "@/db/queries/audit";
import { formatPinnedContextNoteLine, isPinnedContextNote } from "@/domain/pinnedContextNotes";
import { auditTelegramDelivery, withTelegramDeliveryPolicy } from "@/telegram/deliveryPolicy";

import { getBot } from "@/bot/createBot";
import { entityListKeyboard } from "@/bot/keyboards";
import { deleteMessageSafe, registerBotMessage, removeKeyboardSafe } from "./messageLifecycle";

export type LiveDashboardTelegramApi = {
  sendMessage(
    chatId: string,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
  editMessageReplyMarkup(
    chatId: string,
    messageId: number,
    options: { reply_markup: { inline_keyboard: never[] } },
  ): Promise<unknown>;
  editMessageText?(
    chatId: string,
    messageId: number,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
};

export type PlanRenderModel = {
  sections: Array<{
    id: string;
    title: string;
    rowCount: number;
  }>;
};

export async function renderLiveDashboard(params: {
  userId: string;
  timezone: string;
  now?: Date;
  // The Mini App reads the same plan; it must not renumber the chat's plan or log a render.
  readOnly?: boolean;
}) {
  const now = params.now ?? new Date();
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(params.timezone).setLocale("ru");
  const weekEnd = local.plus({ days: 7 }).endOf("day").toUTC().toJSDate();
  await reconcileActiveReminderPolicies({ now, limit: 200 }).catch((error) => {
    logger.warn("Dashboard reminder reconciliation failed without blocking view", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const [timeline, calendarStates] = await Promise.all([
    buildUserTimelineView(params),
    listCalendarSyncStatesForUser(params.userId, 100),
  ]);
  const calendarByItemId = new Map<string, (typeof calendarStates)[number]["sync"]>();
  for (const { sync } of calendarStates) {
    if (!calendarByItemId.has(sync.plannerItemId)) calendarByItemId.set(sync.plannerItemId, sync);
  }
  const itemRows = timeline.rows.filter(
    (row) =>
      row.item && !isPinnedContextNote(row.item) && !["history", "hidden"].includes(row.dateBucket),
  );
  const allPinnedItems = timeline.rows
    .filter((row) => row.item && isPinnedContextNote(row.item) && row.item.status === "active")
    .map((row) => row.item!);
  const pinnedItems = allPinnedItems.slice(0, 8);
  const pinnedItemIds = new Set(allPinnedItems.map((item) => item.id));
  const allItems = itemRows.map((row) => row.item!);
  const activeItemReminders = await listActiveRemindersForItems(
    params.userId,
    allItems.map((item) => item.id),
  ).catch((error) => {
    logger.warn("Dashboard active reminders lookup failed without blocking view", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [] as Reminder[];
  });
  const isPastActiveItem = (item: PlannerItem) => {
    const anchor = item.endAt ?? item.startAt ?? item.dueAt;
    return Boolean(anchor && anchor <= now && item.status === "active");
  };
  const pastTodayItems = itemRows
    .filter((row) => row.dateBucket === "today" && row.item && isPastActiveItem(row.item))
    .map((row) => row.item!)
    .slice(0, 5);
  const pastTodayIds = new Set(pastTodayItems.map((item) => item.id));
  const currentItems = itemRows
    .filter((row) => row.classification === "now" && row.item)
    .map((row) => row.item!)
    .slice(0, 5);
  const currentIds = new Set(currentItems.map((item) => item.id));
  const todayItems = itemRows
    .filter(
      (row) =>
        row.dateBucket === "today" &&
        row.item &&
        !pastTodayIds.has(row.item.id) &&
        !currentIds.has(row.item.id),
    )
    .map((row) => row.item!)
    .sort(compareDashboardItems)
    .slice(0, 8);
  const todayEventItems = todayItems.filter((item) =>
    ["event", "training", "tentative_event"].includes(item.kind),
  );
  const todayTaskItems = todayItems.filter(
    (item) => !["event", "training", "tentative_event"].includes(item.kind),
  );
  const tomorrowItems = itemRows
    .filter((row) => row.dateBucket === "tomorrow")
    .map((row) => row.item!)
    .sort(compareDashboardItems)
    .slice(0, 8);
  const soonItems = itemRows
    .filter((row) => {
      if (row.dateBucket !== "soon") return false;
      const anchor = row.item?.startAt ?? row.item?.dueAt;
      return Boolean(anchor && anchor > now && anchor <= weekEnd);
    })
    .map((row) => row.item!)
    .sort(compareDashboardItems)
    .slice(0, 10);
  const laterItems = itemRows
    .filter((row) => {
      if (row.dateBucket !== "soon") return false;
      const anchor = row.item?.startAt ?? row.item?.dueAt;
      return Boolean(anchor && anchor > weekEnd);
    })
    .map((row) => row.item!)
    .sort(compareDashboardItems)
    .slice(0, 10);
  const scheduledIds = new Set(
    [...currentItems, ...todayItems, ...tomorrowItems, ...soonItems, ...laterItems].map(
      (item) => item.id,
    ),
  );
  const overdueItems = timeline.byBucket.overdue
    .filter((row) => row.item)
    .map((row) => row.item!)
    .slice(0, 5);
  const overdueIds = new Set(overdueItems.map((item) => item.id));
  const pastReviewItems = timeline.byBucket.pastReview
    .filter((row) => row.item)
    .map((row) => row.item!)
    .slice(0, 5);
  const pastReviewIds = new Set(pastReviewItems.map((item) => item.id));
  const unresolvedPastRows = timeline.byBucket.unresolvedPast.filter((row) => row.item);
  const unresolvedPastIds = new Set(unresolvedPastRows.map((row) => row.item!.id));
  const importantItems = allItems
    .filter((item) =>
      shouldRenderInImportantSection({
        itemId: item.id,
        basePriority: getBasePriority({ item }),
        scheduledIds,
        pastTodayIds,
        pastReviewIds,
        overdueIds,
        unresolvedPastIds,
      }),
    )
    .slice(0, 5);
  const longTermItems = itemRows
    .filter(
      (row) =>
        row.dateBucket === "long_term" &&
        row.item &&
        !importantItems.some((item) => item.id === row.item!.id),
    )
    .map((row) => row.item!)
    .slice(0, 5);
  const unresolvedItems = [
    ...pastTodayItems,
    ...unresolvedPastRows.map((row) => row.item!).filter((item) => !pastTodayIds.has(item.id)),
  ].slice(0, 5);
  const carryoverItems = unresolvedItems.filter(
    (item) => item.metadata?.untilDoneCarryover === true,
  );
  const unresolvedNonCarryoverItems = unresolvedItems.filter(
    (item) => item.metadata?.untilDoneCarryover !== true,
  );
  const conflicts = detectPlanConflicts(allItems, { now });
  const itemById = new Map(allItems.map((item) => [item.id, item]));
  const hiddenBackgroundPolicies = timeline.policies.filter((policy) =>
    isBackgroundPostEventPolicy(policy, itemById.get(policy.itemId ?? ""), now),
  );
  const actionablePostEventPolicies = timeline.policies
    .filter((policy) => isActionablePostEventPolicy(policy, now))
    .slice(0, 5);
  const displayPolicies = timeline.policies.filter(
    (policy) =>
      policy.metadata?.hiddenFromDashboard !== true &&
      !pinnedItemIds.has(policy.itemId ?? "") &&
      !isBackgroundPostEventPolicy(policy, itemById.get(policy.itemId ?? ""), now),
  );
  const reviewRequiredPolicies = displayPolicies
    .filter((policy) => isReminderPolicyReviewRequired(policy, itemById.get(policy.itemId ?? "")))
    .slice(0, 8);
  const healthyDisplayPolicies = displayPolicies.filter(
    (policy) => !isReminderPolicyReviewRequired(policy, itemById.get(policy.itemId ?? "")),
  );
  const policiesByItemId = new Map<string, ReminderPolicy[]>();
  for (const policy of healthyDisplayPolicies) {
    if (!policy.itemId) continue;
    policiesByItemId.set(policy.itemId, [...(policiesByItemId.get(policy.itemId) ?? []), policy]);
  }
  const remindersByItemId = new Map<string, Reminder[]>();
  for (const reminder of activeItemReminders) {
    if (!reminder.plannerItemId) continue;
    remindersByItemId.set(reminder.plannerItemId, [
      ...(remindersByItemId.get(reminder.plannerItemId) ?? []),
      reminder,
    ]);
  }
  const unattachedPolicies = healthyDisplayPolicies
    .filter((policy) => !policy.itemId && policy.metadata?.needsReview !== true)
    .slice(0, 5);
  const planRenderModel = buildPlanRenderModel({
    current: currentItems.length,
    todayEvents: todayEventItems.length,
    todayTasks: todayTaskItems.length,
    standaloneReminders: unattachedPolicies.length,
    requiresDecision: reviewRequiredPolicies.length,
    requiresAnswer: actionablePostEventPolicies.length,
    tomorrow: tomorrowItems.length,
    soon: soonItems.length,
    later: laterItems.length,
    pinned: pinnedItems.length,
    important: importantItems.length,
    longTermRules: longTermItems.length,
    overdue: overdueItems.length,
    pastReview: pastReviewItems.length,
    carryover: carryoverItems.length,
    unresolved: unresolvedNonCarryoverItems.length,
  });

  const lines = ["JARVIS · План"];
  const refs: EntityRef[] = [];
  const orderedItems: PlannerItem[] = [];
  let displayIndex = 1;
  const pushRows = (rows: Array<{ text: string; ref: EntityRef; item?: PlannerItem }>) => {
    for (const row of rows) {
      lines.push(formatNumberedDashboardRow(displayIndex, row.text));
      refs.push(row.ref);
      if (row.item) orderedItems.push(row.item);
      displayIndex += 1;
    }
  };
  const itemRowsFor = (items: PlannerItem[], includeDate = false) =>
    items.map((item) => ({
      text: formatDashboardItem(
        item,
        params.timezone,
        calendarByItemId.get(item.id),
        includeDate,
        policiesByItemId.get(item.id) ?? [],
        remindersByItemId.get(item.id) ?? [],
        now,
      ),
      ref: {
        type:
          item.source === "yandex_external"
            ? ("external_calendar_event" as const)
            : ("planner_item" as const),
        id: item.id,
      },
      item,
    }));
  const pinnedRowsFor = (items: PlannerItem[]) =>
    items.map((item) => ({
      text: formatPinnedContextNoteLine(item),
      ref: { type: "planner_item" as const, id: item.id },
      item,
    }));

  if (pinnedItems.length) {
    lines.push("", "Закреплено:");
    pushRows(pinnedRowsFor(pinnedItems));
  }
  if (currentItems.length) {
    lines.push("", "Сейчас / идёт:");
    pushRows(itemRowsFor(currentItems));
  }
  lines.push("", "Сегодня — события:");
  if (todayEventItems.length) {
    pushRows(itemRowsFor(todayEventItems));
  } else {
    lines.push(currentItems.length ? "Больше событий сегодня нет." : "На сегодня нет событий.");
  }
  lines.push("", "Сегодня — задачи:");
  if (todayTaskItems.length) {
    pushRows(itemRowsFor(todayTaskItems));
  } else {
    lines.push("На сегодня задач нет.");
  }
  if (unattachedPolicies.length) {
    lines.push("", "Сегодня — напоминания:");
    pushRows(unattachedPolicies.map((policy) => policyRow(policy, params.timezone)));
  }
  if (reviewRequiredPolicies.length) {
    lines.push("", "Требует решения:");
    pushRows(
      reviewRequiredPolicies.map((policy) =>
        policyReviewRow(policy, itemById.get(policy.itemId ?? ""), params.timezone),
      ),
    );
  }
  if (actionablePostEventPolicies.length) {
    lines.push("", "Требует ответа:");
    pushRows(
      actionablePostEventPolicies.map((policy) =>
        postEventActionRow(policy, itemById.get(policy.itemId ?? ""), params.timezone),
      ),
    );
  }
  if (tomorrowItems.length) {
    lines.push("", "Завтра:");
    pushRows(itemRowsFor(tomorrowItems, true));
  }
  if (soonItems.length) {
    lines.push("", "Скоро:");
    pushRows(itemRowsFor(soonItems, true));
  }
  if (laterItems.length) {
    lines.push("", "Позже:");
    pushRows(itemRowsFor(laterItems, true));
  }
  if (conflicts.length) {
    lines.push("", "Конфликты:");
    lines.push(
      ...conflicts.slice(0, 5).map((conflict) => formatConflictLine(conflict, params.timezone)),
    );
  }
  if (importantItems.length) {
    lines.push("", "Важное:");
    pushRows(itemRowsFor(importantItems, true));
  }
  if (longTermItems.length) {
    lines.push("", "Долгосрочные правила:");
    pushRows(itemRowsFor(longTermItems, true));
  }
  if (overdueItems.length) {
    lines.push("", "Просрочено:");
    pushRows(itemRowsFor(overdueItems, true));
  }
  if (pastReviewItems.length) {
    lines.push("", "Прошло — решить:");
    pushRows(itemRowsFor(pastReviewItems, true));
    lines.push(formatRuItemsRequireDecision(pastReviewItems.length));
  }
  if (carryoverItems.length) {
    lines.push("", "Не закрыто со вчера:");
    pushRows(itemRowsFor(carryoverItems, false));
  }
  if (unresolvedNonCarryoverItems.length) {
    lines.push("", "Неразобранное:");
    pushRows(itemRowsFor(unresolvedNonCarryoverItems, true));
    lines.push(formatRuItemsRequireDecision(unresolvedNonCarryoverItems.length));
  }
  if (!orderedItems.length && allItems.length) {
    const fallback = allItems.slice(0, 8);
    lines.push("", "Открытые записи:");
    pushRows(itemRowsFor(fallback, true));
  }
  if (refs.length) lines.push("", "Нажми номер, чтобы открыть пункт.");

  if (params.readOnly) {
    return {
      text: lines.join("\n"),
      items: orderedItems,
      policies: displayPolicies,
      keyboard: entityListKeyboard(refs, true),
      viewState: null,
      conflicts,
      // Row N of the text is refs[N - 1]; the Mini App uses it to edit the right item.
      refs,
    };
  }

  const viewState = await rememberTaskView({
    userId: params.userId,
    scope: "dashboard",
    title: "JARVIS · План",
    items: orderedItems,
    metadata: { source: "live_dashboard", conflictCount: conflicts.length },
  });

  await Promise.resolve(
    writeAudit({
      userId: params.userId,
      action: "assistant.plan_rendered",
      entityType: "dashboard",
      details: {
        sectionCounts: {
          current: currentItems.length,
          todayEvents: todayEventItems.length,
          todayTasks: todayTaskItems.length,
          unattachedPolicies: unattachedPolicies.length,
          actionablePostEventPolicies: actionablePostEventPolicies.length,
          reviewRequiredPolicies: reviewRequiredPolicies.length,
          tomorrow: tomorrowItems.length,
          soon: soonItems.length,
          later: laterItems.length,
          pinned: pinnedItems.length,
          important: importantItems.length,
          longTerm: longTermItems.length,
          overdue: overdueItems.length,
          pastReview: pastReviewItems.length,
          carryover: carryoverItems.length,
          unresolved: unresolvedNonCarryoverItems.length,
        },
        hiddenBackgroundPolicies: hiddenBackgroundPolicies.length,
        conflictCount: conflicts.length,
        planRenderModel,
      },
    }),
  ).catch(() => undefined);

  return {
    text: lines.join("\n"),
    items: orderedItems,
    policies: displayPolicies,
    keyboard: entityListKeyboard(refs, true),
    viewState,
    conflicts,
  };
}

export function shouldRenderInImportantSection(params: {
  itemId: string;
  basePriority: number;
  scheduledIds: ReadonlySet<string>;
  pastTodayIds: ReadonlySet<string>;
  pastReviewIds: ReadonlySet<string>;
  overdueIds: ReadonlySet<string>;
  unresolvedPastIds: ReadonlySet<string>;
}) {
  return (
    params.basePriority >= 4 &&
    !params.scheduledIds.has(params.itemId) &&
    !params.pastTodayIds.has(params.itemId) &&
    !params.pastReviewIds.has(params.itemId) &&
    !params.overdueIds.has(params.itemId) &&
    !params.unresolvedPastIds.has(params.itemId)
  );
}

function buildPlanRenderModel(counts: {
  current: number;
  pinned: number;
  todayEvents: number;
  todayTasks: number;
  standaloneReminders: number;
  requiresDecision: number;
  requiresAnswer: number;
  tomorrow: number;
  soon: number;
  later: number;
  important: number;
  longTermRules: number;
  overdue: number;
  pastReview: number;
  carryover: number;
  unresolved: number;
}): PlanRenderModel {
  return {
    sections: [
      { id: "current", title: "Сейчас / идёт", rowCount: counts.current },
      { id: "pinned", title: "Закреплено", rowCount: counts.pinned },
      { id: "today_events", title: "Сегодня — события", rowCount: counts.todayEvents },
      { id: "today_tasks", title: "Сегодня — задачи", rowCount: counts.todayTasks },
      {
        id: "today_reminders",
        title: "Сегодня — напоминания",
        rowCount: counts.standaloneReminders,
      },
      {
        id: "requires_decision",
        title: "Требует решения",
        rowCount: counts.requiresDecision,
      },
      { id: "requires_answer", title: "Требует ответа", rowCount: counts.requiresAnswer },
      { id: "tomorrow", title: "Завтра", rowCount: counts.tomorrow },
      { id: "soon", title: "Скоро", rowCount: counts.soon },
      { id: "later", title: "Позже", rowCount: counts.later },
      { id: "important", title: "Важное", rowCount: counts.important },
      {
        id: "long_term_rules",
        title: "Долгосрочные правила",
        rowCount: counts.longTermRules,
      },
      { id: "overdue", title: "Просрочено", rowCount: counts.overdue },
      { id: "past_review", title: "Прошло — решить", rowCount: counts.pastReview },
      { id: "carryover", title: "Не закрыто со вчера", rowCount: counts.carryover },
      { id: "unresolved", title: "Неразобранное", rowCount: counts.unresolved },
    ].filter((section) => section.rowCount > 0),
  };
}
export async function renderReminderPolicyList(params: {
  userId: string;
  timezone: string;
  longTermOnly?: boolean;
  category?: string | null;
}) {
  await reconcileActiveReminderPolicies({ limit: 200 }).catch((error) => {
    logger.warn("Reminder list reconciliation failed without blocking view", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const [timeline, legacyAll, pinnedNotes] = await Promise.all([
    buildUserTimelineView({ userId: params.userId, timezone: params.timezone }),
    listLegacyReminderLikeItems(params.userId, 50),
    listPinnedContextNotes(params.userId, 30),
  ]);
  const policies = timeline.policies.filter((policy) => {
    if (params.category) {
      return (
        policy.category === params.category || policy.category === `recurring_${params.category}`
      );
    }
    if (params.longTermOnly) {
      return classifyTimelineItem({ policy }, new Date(), params.timezone) === "long_term";
    }
    return true;
  });
  const legacy = params.longTermOnly
    ? legacyAll.filter(
        (item) =>
          item.visibility === "long_term" ||
          /(зеркал|жкх|регулярное\s+напоминание)/i.test(item.title),
      )
    : legacyAll;
  const title = params.longTermOnly ? "Дальние и регулярные напоминания" : "Активные напоминания";
  return [
    title,
    "",
    ...(policies.length
      ? policies.map((policy, index) => `${index + 1}. ${formatPolicy(policy, params.timezone)}`)
      : ["Активные политики: 0"]),
    ...(legacy.length
      ? [
          "",
          `Нашёл ${legacy.length} старых записей, похожих на напоминания, но без policy:`,
          ...legacy.map((item, index) => `${index + 1}. ${item.title}`),
          "",
          "Они не считаются работающими регулярными напоминаниями до конвертации.",
        ]
      : []),
    ...(pinnedNotes.length
      ? [
          "",
          "Закреплённые заметки:",
          ...pinnedNotes.map((item) => formatPinnedContextNoteLine(item)),
        ]
      : []),
  ].join("\n");
}

export async function sendOrRefreshLiveDashboard(params: {
  userId: string;
  chatId: string;
  timezone: string;
  now?: Date;
  api?: LiveDashboardTelegramApi;
  // Automatic refreshes (reminder delivery, runner) keep the existing card when the
  // plan text is identical instead of deleting and re-sending it every time.
  skipIfUnchanged?: boolean;
}) {
  const api = params.api ?? (getBot().api as unknown as LiveDashboardTelegramApi);
  const previous = await getActiveDashboard(params.userId, params.chatId);
  const rendered = await renderLiveDashboard(params);
  if (params.skipIfUnchanged && previous && previous.payload?.text === rendered.text) {
    return { dashboard: previous, ...rendered, unchanged: true as const };
  }
  if (previous) {
    try {
      const deleted = await deleteMessageSafe({
        chatId: params.chatId,
        messageId: previous.messageId,
        api,
      });
      await markDashboardStatus(previous.id, deleted ? "deleted" : "failed_to_delete");
      if (!deleted && api.editMessageText && typeof previous.payload?.text === "string") {
        await api
          .editMessageText(
            params.chatId,
            previous.messageId,
            `Устарело\n\n${previous.payload.text}`,
            {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [] },
            },
          )
          .catch(() => undefined);
      }
    } catch (error) {
      await removeKeyboardSafe({
        chatId: params.chatId,
        messageId: previous.messageId,
        api,
      });
      await markDashboardStatus(previous.id, "failed_to_delete");
      logger.warn("Old dashboard could not be deleted", {
        dashboardId: previous.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sent = await api.sendMessage(params.chatId, rendered.text, {
    parse_mode: "HTML",
    reply_markup: rendered.keyboard,
    ...withTelegramDeliveryPolicy("dashboard_refresh"),
  });
  await auditTelegramDelivery({
    userId: params.userId,
    messageKind: "dashboard_refresh",
    entityType: "dashboard",
    details: { automaticRefresh: true },
  });
  const dashboard = await createActiveDashboard({
    userId: params.userId,
    chatId: params.chatId,
    messageId: sent.message_id,
    payload: {
      text: rendered.text,
      itemIds: rendered.items.map((item) => item.id),
      policyIds: rendered.policies.map((policy) => policy.id),
    },
  });
  await registerBotMessage({
    userId: params.userId,
    chatId: params.chatId,
    messageId: sent.message_id,
    purpose: "dashboard",
    metadata: { dashboardId: dashboard.id },
  });
  return { dashboard, ...rendered, unchanged: false as const };
}

export async function refreshDashboardAfterMutation(params: {
  userId: string;
  chatId: string | number;
  timezone: string;
  now?: Date;
  api?: LiveDashboardTelegramApi;
  skipIfUnchanged?: boolean;
}) {
  return sendOrRefreshLiveDashboard({
    ...params,
    chatId: String(params.chatId),
  });
}

export function formatDashboardItem(
  item: PlannerItem,
  timezone: string,
  calendar?: { status: string; lastError: string | null } | null,
  includeDate = false,
  policies: ReminderPolicy[] = [],
  reminders: Reminder[] = [],
  now = new Date(),
) {
  if (item.status === "completed") return `✅ ${item.title} — завершено`;
  const time = item.startAt
    ? includeDate
      ? formatRuWeekdayDateTime(item.startAt, item.timezone || timezone)
      : DateTime.fromJSDate(item.startAt, { zone: "utc" })
          .setZone(item.timezone || timezone)
          .toFormat("HH:mm")
    : item.dueAt
      ? includeDate
        ? formatDeadlineDateTime(item.dueAt, item.timezone || timezone)
        : `до ${DateTime.fromJSDate(item.dueAt, { zone: "utc" })
            .setZone(item.timezone || timezone)
            .toFormat("HH:mm")}`
      : null;
  const end = item.endAt
    ? DateTime.fromJSDate(item.endAt, { zone: "utc" })
        .setZone(item.timezone || timezone)
        .toFormat("HH:mm")
    : null;
  const important =
    item.source === "yandex_external" ? "" : visibleImportanceMarker({ item }).split(" ")[0];
  const persistent = shouldShowPersistentMarker({
    item,
    hasPersistentPolicy: policies.some(isPersistentReminderPolicy),
  })
    ? "❗ "
    : "";
  const calendarStatus =
    ["event", "training", "tentative_event"].includes(item.kind) &&
    ["pending_retry", "failed", "error"].includes(calendar?.status ?? "")
      ? ` · Календарь: ${calendar?.lastError ?? calendar?.status}, повторю автоматически`
      : "";
  const beforeEventSummary = formatDedupedBeforeEventPolicies(policies, timezone, {
    item,
  });
  const followupReminderLines = formatEventFollowupReminderLines(reminders, timezone, {
    item,
    now,
    todayOnly: true,
  });
  const itemReminderLines = formatItemReminderPolicyLines(policies, timezone, { item, now });
  const relativeReminderLabels = new Set(beforeEventSummary.split(", ").filter(Boolean));
  const compactReminderParts = [
    beforeEventSummary,
    ...followupReminderLines,
    ...itemReminderLines.filter((line) => !relativeReminderLabels.has(line)),
  ].filter(Boolean);
  const reminderLines = compactReminderParts.length
    ? [
        `   ${dashboardReminderIcon(item, policies, timezone, now)} ${[
          ...new Set(compactReminderParts),
        ].join("; ")}`,
      ]
    : [];
  return [
    `${time ? `${time}${end ? `–${end}` : ""} · ` : ""}${important ? `${important} ` : ""}${persistent}${item.title}${calendarStatus}`,
    ...reminderLines,
  ].join("\n");
}

function compareDashboardItems(left: PlannerItem, right: PlannerItem) {
  const leftRank = left.startAt ? 0 : left.dueAt ? 1 : 2;
  const rightRank = right.startAt ? 0 : right.dueAt ? 1 : 2;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return (
    ((left.startAt ?? left.dueAt)?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    ((right.startAt ?? right.dueAt)?.getTime() ?? Number.MAX_SAFE_INTEGER)
  );
}

function formatPolicy(policy: ReminderPolicy, timezone: string) {
  const priorityLabel = importanceMarker(getBasePriority({ policy })).split(" ")[0];
  return `${priorityLabel ? `${priorityLabel} · ` : ""}${policy.title}\n   ${formatHumanReminderPolicy(policy, timezone, { includeNext: true, includeMarker: false })}`;
}

function policyRow(policy: ReminderPolicy, timezone: string): { text: string; ref: EntityRef } {
  const campaignGroup = String(policy.metadata?.campaignGroup ?? "");
  return {
    text: formatPolicy(policy, timezone),
    ref: campaignGroup
      ? { type: "campaign", id: campaignGroup }
      : { type: "reminder_policy", id: policy.id },
  };
}

function policyReviewRow(
  policy: ReminderPolicy,
  item: PlannerItem | undefined,
  timezone: string,
): { text: string; ref: EntityRef; item?: PlannerItem } {
  return {
    text: item
      ? `${item.title}\n   Требует проверки: ${formatHumanReminderPolicy(policy, timezone, {
          includeNext: true,
          includeMarker: false,
          item,
        })}`
      : formatPolicy(policy, timezone),
    ref: item ? { type: "planner_item", id: item.id } : { type: "reminder_policy", id: policy.id },
    item,
  };
}

function formatNumberedDashboardRow(index: number, text: string) {
  return `<b>${index}</b> · ${escapeTelegramHtml(text)}`;
}

function escapeTelegramHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isTodayScopedItem(item: PlannerItem, timezone: string, now: Date) {
  const zone = item.timezone || timezone;
  const today = DateTime.fromJSDate(now, { zone: "utc" }).setZone(zone);
  const anchor = item.startAt ?? item.dueAt ?? null;
  if (!anchor) return false;
  return DateTime.fromJSDate(anchor, { zone: "utc" }).setZone(zone).hasSame(today, "day");
}

function dashboardReminderIcon(
  item: PlannerItem,
  policies: ReminderPolicy[],
  timezone: string,
  now: Date,
) {
  if (
    item.kind === "recurring_task" ||
    item.visibility === "long_term" ||
    policies.some((policy) =>
      Boolean(
        policy.recurrenceRule ||
        policy.policyType === "recurring" ||
        policy.policyType === "long_term" ||
        policy.policyType === "nag_until_ack" ||
        (policy.intervalMinutes && policy.policyType !== "interval_window"),
      ),
    )
  ) {
    return "↻";
  }
  if (isTodayScopedItem(item, timezone, now)) return "⏰";
  return "🗓";
}

function isPostEventPolicy(policy: ReminderPolicy) {
  return ["after_event", "post_event_menu"].includes(policy.policyType);
}

function isActionablePostEventPolicy(policy: ReminderPolicy, now: Date) {
  if (!isPostEventPolicy(policy)) return false;
  const fireAt = policy.nextFireAt ?? policy.startsAt ?? null;
  return Boolean(fireAt && fireAt <= now && policy.status === "active");
}

function isBackgroundPostEventPolicy(
  policy: ReminderPolicy,
  item: PlannerItem | undefined,
  now: Date,
) {
  if (!isPostEventPolicy(policy)) return false;
  if (isActionablePostEventPolicy(policy, now)) return false;
  return Boolean(item || policy.nextFireAt || policy.startsAt);
}

function postEventActionRow(
  policy: ReminderPolicy,
  item: PlannerItem | undefined,
  timezone: string,
): { text: string; ref: EntityRef; item?: PlannerItem } {
  const target = item?.title ?? policy.title;
  return {
    text: `${target}\n   ${formatHumanReminderPolicy(policy, timezone, {
      includeNext: true,
      includeMarker: false,
      item,
    })}`,
    ref: item ? { type: "planner_item", id: item.id } : { type: "reminder_policy", id: policy.id },
    item,
  };
}
