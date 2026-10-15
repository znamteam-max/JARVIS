import { DateTime } from "luxon";

import type { ActionPlan, ActionPlanItem } from "@/ai/schemas";
import type { PlannerActionProposal } from "@/ai/schemas";
import type { PlannerItem, Reminder, ReminderPolicy } from "@/db/schema";
import {
  formatLocalDateRange,
  formatLocalDateTime,
  formatRuWeekdayDateRange,
} from "@/domain/dateTime";
import { formatDeadlineDateTime } from "@/domain/deadlineSemantics";
import { formatRuPlural } from "@/lib/ruPlural";
import { isEventLikePlannerItem } from "@/domain/eventReminderSemantics";
import {
  formatHumanReminderPolicy,
  formatItemReminderPolicyLines,
} from "@/domain/reminderPolicyPresentation";
import {
  formatRecurringRuleHuman,
  parseCanonicalRecurrenceRule,
} from "@/domain/recurringPolicySemantics";
import {
  isTodayUntilDonePlannerItem,
  isTodayUntilDoneReminderPolicy,
} from "@/domain/todayUntilDoneTask";

const kindLabels: Record<string, string> = {
  event: "Встреча",
  task: "Задача",
  training: "Тренировка",
  note: "Заметка",
  preparation_task: "Подготовка",
  tentative_event: "Под вопросом",
  recurring_task: "Повтор",
};

const actionSectionLabels: Record<string, string> = {
  event: "Встречи",
  preparation: "Подготовка",
  tentative_event: "Под вопросом",
  training: "Тренировка",
  recurring_task: "Повторяющиеся напоминания",
  task: "Задачи",
  reminder: "Напоминания",
  note: "Заметки",
  followup: "Follow-up",
};

export function formatProposalCard(proposal: PlannerActionProposal, timezone: string): string {
  const title = proposal.title ?? "Без названия";
  const kind = proposal.kind ? kindLabels[proposal.kind] : "Запись";
  const time =
    proposal.startAtLocal || proposal.dueAtLocal
      ? formatProposalLocalTime(
          proposal.startAtLocal ?? proposal.dueAtLocal,
          proposal.timezone ?? timezone,
        )
      : "без времени";
  const reminders = proposal.reminderPresets.length
    ? proposal.reminderPresets.join(", ")
    : "по умолчанию";

  return [
    `${kind}: ${title}`,
    `Когда: ${time}`,
    proposal.location ? `Где: ${proposal.location}` : null,
    proposal.description ? `Детали: ${proposal.description}` : null,
    `Напоминания: ${reminders}`,
    "",
    "Сохранить эту запись?",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatCreatedItem(item: PlannerItem, reminderCount: number): string {
  const time = formatLocalDateRange(item.startAt, item.endAt ?? item.dueAt, item.timezone);
  const reminderLine =
    reminderCount > 0 ? `Напоминаний: ${reminderCount}.` : "Будущих напоминаний не добавлял.";
  return `✅ Записал: ${item.title}\n${time}\n${reminderLine}`;
}

export function formatActionPlanCard(plan: ActionPlan, timezone: string): string {
  if (plan.intent === "answer") return plan.reply || "Покажу через команды расписания.";
  if (plan.intent === "clarify") {
    const questions = plan.clarificationQuestions.length
      ? `\n${plan.clarificationQuestions.map((question) => `• ${question}`).join("\n")}`
      : "";
    return `${plan.reply || "Нужно уточнение."}${questions}`;
  }

  const grouped = groupActions(plan.actions);
  const lines = ["Разложил сообщение:"];
  for (const [section, actions] of grouped) {
    lines.push("", `${actionSectionLabels[section] ?? section}:`);
    for (const action of actions) {
      lines.push(`• ${formatActionPlanItem(action, timezone)}`);
    }
  }

  const reminderCount = plan.actions.reduce((count, action) => count + action.reminders.length, 0);
  if (reminderCount) {
    lines.push("", `Напоминания поставлю: ${reminderCount}.`);
  }
  if (plan.requiresConfirmation) {
    lines.push("", "Сохранить этот план?");
  }
  return lines.join("\n");
}

export function formatCommittedPlanSummary(params: {
  items: PlannerItem[];
  reminderCount: number;
  reminderPolicies?: ReminderPolicy[];
  timezone: string;
  intro?: string;
}) {
  const lines = [
    params.intro ?? `Добавил ${params.items.length} ${itemCountLabel(params.items.length)}:`,
  ];
  const policiesByItemId = new Map<string, ReminderPolicy[]>();
  for (const policy of params.reminderPolicies ?? []) {
    if (!policy.itemId) continue;
    policiesByItemId.set(policy.itemId, [...(policiesByItemId.get(policy.itemId) ?? []), policy]);
  }
  const groupedReminderTemplate = params.items.some(
    (item) => item.metadata?.reminderTemplateAppliedPerEvent === true,
  );
  for (const [index, item] of params.items.entries()) {
    lines.push(
      `${index + 1}. ${getItemLabel(item)}: ${item.title} — ${formatItemScheduleAndDeadline(item, params.timezone)}`,
    );
    if (groupedReminderTemplate) {
      const reminderLines = formatItemReminderPolicyLines(
        policiesByItemId.get(item.id) ?? [],
        params.timezone,
        { item },
      );
      if (reminderLines.length) {
        lines.push(`   Напоминания: ${reminderLines.join(", ")}`);
      }
    }
  }
  const hasUnremindedDeadline =
    params.items.some((item) => item.dueAt) && params.reminderCount === 0;
  lines.push(
    params.reminderCount
      ? `Напоминаний создано: ${params.reminderCount}.`
      : hasUnremindedDeadline
        ? "Напоминаний пока нет."
        : "Будущих напоминаний не добавлял.",
  );
  if (params.reminderPolicies?.length && !groupedReminderTemplate) {
    lines.push("", "Напоминания:");
    for (const policy of params.reminderPolicies) {
      lines.push(
        `• ${formatHumanReminderPolicy(policy, params.timezone, {
          includeMarker: false,
          includeNext: policy.metadata?.openEndedUntilDone === true,
        })}`,
      );
    }
  }
  lines.push("", hasUnremindedDeadline ? "Напомнить?" : "Что настроить?");
  return lines.join("\n");
}

function itemCountLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "пункт";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "пункта";
  return "пунктов";
}

export function formatItemList(title: string, items: PlannerItem[], timezone: string): string {
  if (!items.length) return `${title}\n\nПусто.`;
  const lines = sortItemsForDisplay(items).map((item) => {
    const date = formatLocalDateTime(item.startAt ?? item.dueAt, item.timezone || timezone);
    const order = getOrderIndex(item);
    const orderPrefix = order ? `${order}. ` : "";
    const floating = isFloating(item) ? " — без времени" : "";
    const tentative = isTentative(item) ? " — предварительно" : "";
    return `• ${orderPrefix}${date}${floating}${tentative} — ${getItemLabel(item)}: ${item.title}`;
  });
  return `${title}\n\n${lines.join("\n")}`;
}

export function formatTaskManagementView(params: {
  title: string;
  items: PlannerItem[];
  timezone: string;
}) {
  if (!params.items.length) {
    return `${params.title}\n\nСейчас открытых задач нет.`;
  }

  const today: string[] = [];
  const training: string[] = [];
  const overdue: string[] = [];
  const floating: string[] = [];
  const now = Date.now();

  for (const [index, item] of sortItemsForDisplay(params.items).entries()) {
    const line = `${index + 1}. [ ] ${item.title}${isFloating(item) ? " — без времени" : ""}`;
    if ((item.dueAt ?? item.startAt)?.getTime() && (item.dueAt ?? item.startAt)!.getTime() < now) {
      overdue.push(line);
    } else if (item.kind === "training") {
      training.push(`${line}${isTentative(item) ? " — предварительно" : ""}`);
    } else if (isFloating(item)) {
      floating.push(line);
    } else {
      today.push(line);
    }
  }

  const sections = [
    ["Сегодня", today],
    ["Без времени", floating],
    ["Тренировки", training],
    ["Просроченное", overdue],
  ] as const;

  const lines = [
    params.title,
    "",
    "Ок, ничего нового не создаю. Показываю текущие дела для редактирования.",
  ];
  for (const [sectionTitle, sectionItems] of sections) {
    if (!sectionItems.length) continue;
    lines.push("", `${sectionTitle}:`, ...sectionItems);
  }
  lines.push(
    "",
    "Доступно: отметить выполненным, перенести, удалить, изменить время или добавить напоминание.",
  );
  return lines.join("\n");
}

export function formatReminderMessage(
  reminder: Reminder,
  item?: PlannerItem | null,
  options?: { policy?: ReminderPolicy | null; now?: Date },
): string {
  if (!item) {
    // Without an item the policy (or the reminder payload) still knows what this is about.
    const payloadTitle = reminder.payload?.title;
    const title =
      options?.policy?.title ?? (typeof payloadTitle === "string" ? payloadTitle : null);
    return title ? `Напоминание: ${title}` : "Напоминание.";
  }
  const policy = options?.policy ?? null;
  const now = options?.now ?? new Date();
  const timezone = item.timezone || policy?.timezone || "Europe/Moscow";
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  const parsedRecurrence = parseCanonicalRecurrenceRule(policy?.recurrenceRule ?? null);
  if (policy?.metadata?.openEndedUntilDone === true) {
    const interval = formatOpenEndedNagInterval(policy.intervalMinutes);
    const snoozed =
      policy.snoozedUntil && policy.snoozedUntil > now
        ? `Отложено до ${DateTime.fromJSDate(policy.snoozedUntil, { zone: "utc" })
            .setZone(timezone)
            .toFormat("HH:mm")}, потом ${interval}, пока не отметишь выполненным.`
        : `Повторяю ${interval}, пока не отметишь выполненным.`;
    return `Напоминание: ${item.title}\n${snoozed}`;
  }
  if (parsedRecurrence?.kind === "monthly_day_range" && parsedRecurrence.timeLocal) {
    const rule = formatRecurringRuleHuman(policy?.recurrenceRule ?? null);
    return `Напоминание: ${item.title}\nСегодня, ${nowLocal.toFormat("dd.LL")}. Правило: ${rule}.`;
  }
  if (
    isTodayUntilDoneReminderPolicy(policy) ||
    isTodayUntilDonePlannerItem(item)
  ) {
    const itemDate = item.dueAt ?? item.startAt;
    const itemLocal = itemDate
      ? DateTime.fromJSDate(itemDate, { zone: "utc" }).setZone(timezone)
      : null;
    const carried =
      policy?.metadata?.untilDoneCarryover === true ||
      item.metadata?.untilDoneCarryover === true ||
      Boolean(itemLocal && itemLocal.startOf("day") < nowLocal.startOf("day"));
    const effectiveEnd = policy?.endsAt
      ? DateTime.fromJSDate(policy.endsAt, { zone: "utc" }).setZone(timezone)
      : nowLocal.set({ hour: 23, minute: 59 });
    return carried
      ? `Напоминание: ${item.title}\nНе закрыто со вчера. Продолжаю сегодня до ${effectiveEnd.toFormat("HH:mm")}.`
      : `Напоминание: ${item.title}\nСегодня до ${effectiveEnd.toFormat("HH:mm")}.`;
  }
  const when = formatRuWeekdayDateRange(item.startAt ?? item.dueAt, item.endAt, item.timezone);
  if (
    isEventLikePlannerItem(item) &&
    !["followup", "training_followup", "after_event"].includes(reminder.type)
  ) {
    const subject = item.kind === "training" ? "тренировке" : "событии";
    return `🔔 Напоминание о ${subject}\n${item.title}\n${when}`;
  }
  if (reminder.repeatUntilAck || item.kind === "recurring_task") {
    const rule = formatRecurringRuleHuman(policy?.recurrenceRule ?? null);
    const occurrence = DateTime.fromJSDate(reminder.scheduledAt, { zone: "utc" })
      .setZone(timezone)
      .toFormat("ccc, dd.LL HH:mm");
    if (rule) return `Напоминание: ${item.title}\n${occurrence}. Правило: ${rule}.`;
    const overdue = formatOverdueLine(item, nowLocal);
    return overdue
      ? `Напоминание: ${item.title}\n${overdue}\n\nСделано — отметь кнопкой. Не успеваешь сейчас — отложи кнопкой, я напомню снова.`
      : `Повторяющееся напоминание: ${item.title}\n${when}\n\nНажми кнопку, чтобы я понял, что делать дальше.`;
  }
  if (reminder.type === "followup") {
    if (item.kind === "tentative_event" || isTentative(item)) {
      return `${item.title} был или отменился?\n\nМожно отметить, что был, что не было, перенести или записать итоги.`;
    }
    return `Как прошла встреча: ${item.title}?\n\nМожешь голосом надиктовать итоги, а я выделю новые задачи.`;
  }
  if (reminder.type === "training_followup") {
    return `Как прошла тренировка: ${item.title}?\n\nМожно коротко записать ощущения и что скорректировать.`;
  }
  if (reminder.type === "task_overdue") {
    return `Проверка задачи: ${item.title}\nСрок был: ${when}`;
  }
  return `Напоминание: ${item.title}\n${when}`;
}

// "Срок был Вс, 20.09 23:59 — просрочено на 5 дней" instead of repeating a stale date as if current.
function formatOverdueLine(item: PlannerItem, nowLocal: DateTime) {
  const anchor = item.dueAt ?? item.endAt ?? item.startAt;
  if (!anchor || anchor.getTime() >= nowLocal.toMillis()) return null;
  const anchorLocal = DateTime.fromJSDate(anchor, { zone: "utc" }).setZone(nowLocal.zone);
  const days = Math.floor(nowLocal.startOf("day").diff(anchorLocal.startOf("day"), "days").days);
  if (days < 1) return null;
  const date = formatRuWeekdayDateRange(item.dueAt ?? item.startAt, null, item.timezone);
  return `Срок был ${date} — просрочено на ${formatRuPlural(days, ["день", "дня", "дней"])}.`;
}

function formatOpenEndedNagInterval(intervalMinutes: number | null) {
  if (intervalMinutes === 60) return "каждый час";
  if (intervalMinutes === 30) return "каждые 30 минут";
  return `каждые ${intervalMinutes ?? 60} минут`;
}

function getItemLabel(item: PlannerItem): string {
  const metadata = item.metadata ?? {};
  if (metadata.itemType === "call") return "Созвон";
  if (metadata.trainingReport === true) return "Отчёт";
  return kindLabels[item.kind] ?? item.kind;
}

function getOrderIndex(item: PlannerItem): number | null {
  const value = item.metadata?.orderIndex;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isFloating(item: PlannerItem): boolean {
  return item.metadata?.isFloating === true || item.metadata?.timeUnspecified === true;
}

function isTentative(item: PlannerItem): boolean {
  return (
    item.kind === "tentative_event" ||
    item.metadata?.tentative === true ||
    item.metadata?.tentativeTrainingPlan === true
  );
}

function sortItemsForDisplay(items: PlannerItem[]) {
  return [...items].sort((a, b) => {
    const aOrder = getOrderIndex(a);
    const bOrder = getOrderIndex(b);
    if (aOrder && bOrder) return aOrder - bOrder;
    if (aOrder) return -1;
    if (bOrder) return 1;
    const aTime = (a.startAt ?? a.dueAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bTime = (b.startAt ?? b.dueAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  });
}

function groupActions(actions: ActionPlanItem[]) {
  const groups = new Map<string, ActionPlanItem[]>();
  for (const action of actions) {
    const key = action.actionType;
    groups.set(key, [...(groups.get(key) ?? []), action]);
  }
  return [...groups.entries()];
}

function formatActionPlanItem(action: ActionPlanItem, timezone: string): string {
  if (isUntilDoneActionPlanItem(action)) {
    const interval =
      typeof action.metadata?.intervalMinutes === "number" ? action.metadata.intervalMinutes : 60;
    return `${action.title}\n  ↻ ${formatOpenEndedNagInterval(interval)}, пока не отмечу выполненным`;
  }
  const zone = action.timezone ?? timezone;
  const schedule = action.startAtLocal ? formatProposalLocalTime(action.startAtLocal, zone) : null;
  const deadline = action.dueAtLocal
    ? `дедлайн ${formatProposalDeadline(action.dueAtLocal, zone)}`
    : null;
  const when = [schedule, deadline].filter(Boolean).join("; ") || "без времени";
  const tentative = action.tentative ? "tentative: " : "";
  const recurrence = action.recurrence
    ? `; повтор ${action.recurrence.daysOfWeek.join(",") || action.recurrence.frequency} ${action.recurrence.timeLocal ?? ""}`.trim()
    : "";
  return `${when} — ${tentative}${action.title}${action.description ? ` (${action.description})` : ""}${recurrence}`;
}

function isUntilDoneActionPlanItem(action: ActionPlanItem) {
  return (
    action.metadata?.stopCondition === "until_done" &&
    (action.metadata?.openEndedUntilDone === true ||
      action.metadata?.timeScope === "persistent" ||
      action.metadata?.timeScope === "today") &&
    typeof action.metadata?.intervalMinutes === "number"
  );
}

function formatItemScheduleAndDeadline(item: PlannerItem, timezone: string) {
  if (
    item.metadata?.stopCondition === "until_done" &&
    (item.metadata?.openEndedUntilDone === true || item.metadata?.timeScope === "persistent")
  ) {
    const interval =
      typeof item.metadata?.intervalMinutes === "number" ? item.metadata.intervalMinutes : 60;
    return `${formatOpenEndedNagInterval(interval)}, пока не отмечу выполненным`;
  }
  const zone = item.timezone || timezone;
  const schedule = item.startAt ? formatLocalDateRange(item.startAt, item.endAt, zone) : null;
  const deadline = item.dueAt ? `дедлайн ${formatDeadlineDateTime(item.dueAt, zone)}` : null;
  return [schedule, deadline].filter(Boolean).join("; ") || "без времени";
}

function formatProposalDeadline(localIso: string, timezone: string) {
  const dt = DateTime.fromISO(localIso, { zone: timezone });
  if (!dt.isValid) return localIso;
  return `${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"][dt.weekday - 1]}, ${dt.toFormat("dd.LL")} до ${dt.toFormat("HH:mm")}`;
}

function formatProposalLocalTime(localIso: string | null | undefined, timezone: string): string {
  if (!localIso) return "без времени";
  const dt = DateTime.fromISO(localIso, { zone: timezone }).setLocale("ru");
  if (!dt.isValid) return localIso;
  return dt.toLocaleString(DateTime.DATETIME_MED);
}
