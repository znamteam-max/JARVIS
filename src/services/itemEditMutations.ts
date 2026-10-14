import { DateTime } from "luxon";

import {
  createReminderPolicyIfMissing,
  listReminderPoliciesForItem,
  updateReminderPolicy,
} from "@/db/queries/reminderPolicies";
import { cancelPendingRemindersForPolicy } from "@/db/queries/reminders";
import { updatePlannerItemDetails } from "@/db/queries/items";
import type { PlannerItem, ReminderPolicy } from "@/db/schema";
import { materializeNextPolicyReminder } from "@/services/reminderPolicyEngine";
import { formatRuWeekdayDateRange } from "@/domain/dateTime";
import { formatDeadlineDateTime, parseDeadlineSemantics } from "@/domain/deadlineSemantics";
import {
  detectBeforeEventReminderMode,
  parseBeforeEventReminderSpecsForAnchor,
} from "@/domain/beforeEventReminderParsing";
import {
  normalizeUntilDoneReminder,
  parseExplicitReminderIntervalMinutes,
} from "@/domain/untilDoneReminderText";

import { parseRussianDateTime, parseRussianTimeRange } from "./russianDateTime";

export type ItemEditReminderMutation =
  | {
      policyType: "nag_until_ack";
      startsAtLocal: string;
      endsAtLocal?: string;
      intervalMinutes: number;
      activeWindowStart: string;
      activeWindowEnd?: string;
      stopCondition: "until_done";
    }
  | {
      policyType: "before_event_multi";
      reminders: Array<{
        fireAtLocal: string;
        minutesBefore: number;
        label: string;
      }>;
      mode: "add" | "replace" | "ask";
      mutationSource?: string;
    };

export type ItemEditMutation = {
  itemId: string;
  title?: string;
  kind?: string;
  scheduledForLocal?: string;
  endsAtLocal?: string;
  allDay?: boolean;
  deadlineAtLocal?: string;
  clearDeadline?: boolean;
  reminderPolicy?: ItemEditReminderMutation;
  changedFields: string[];
  warnings: string[];
  pastConfirmationRequired: boolean;
};

export type ItemEditApplyResult = {
  item: PlannerItem | null;
  policyIds: string[];
  reminderIds: string[];
  warnings: string[];
  undoPayload: Record<string, unknown>;
};

export function parseItemEditMutation(params: {
  text: string;
  item: PlannerItem;
  timezone: string;
  now?: Date;
}): ItemEditMutation {
  const now = params.now ?? new Date();
  const item = params.item;
  const timezone = item.timezone || params.timezone;
  const anchor = item.startAt ?? item.dueAt;
  const clearDeadline = /(?:убери|удали|сними|без)\s+(?:дедлайн|срок)/i.test(params.text);
  const deadline = clearDeadline
    ? null
    : parseDeadlineSemantics({
        text: params.text,
        timezone,
        now,
        baseDate: anchor,
      });
  const title = deadline || clearDeadline ? null : parseRenamedTitle(params.text);
  const allDayRange = deadline
    ? null
    : parseAllDaySchedule({
        text: params.text,
        item,
        timezone,
        now,
      });
  const parsedTimeRange = parseRussianTimeRange({
    text: params.text,
    timezone,
    now,
    baseDate: anchor,
  });
  const timeRange =
    allDayRange ??
    (deadline?.scheduledStartLocal && deadline.scheduledEndLocal
      ? {
          startLocal: deadline.scheduledStartLocal,
          endLocal: deadline.scheduledEndLocal,
          warnings: [],
          pastConfirmationRequired: false,
        }
      : deadline
        ? null
        : parsedTimeRange);
  // "завтра с 6 до 9, каждый час напоминай": the range says when to remind, it is not a
  // new time slot for the item.
  const reminderWindow =
    timeRange && !allDayRange
      ? parseReminderWindowMutation({ text: params.text, range: timeRange })
      : null;
  const scheduleRange = reminderWindow ? null : timeRange;
  const dateTime =
    timeRange || deadline
      ? null
      : parseRussianDateTime({
          text: params.text,
          timezone,
          now,
          baseDate: anchor,
        });
  const scheduledLocal = scheduleRange?.startLocal ?? dateTime?.local ?? null;
  const reminderPolicy =
    reminderWindow ??
    parseReminderMutation({
      text: params.text,
      timezone,
      dateTimeLocal: scheduledLocal,
      item,
      now,
    });
  const kind =
    (title ? inferKind({ title, currentKind: item.kind }) : null) ??
    (allDayRange && ["task", "preparation_task"].includes(item.kind) ? "event" : null) ??
    (scheduleRange && !deadline && ["task", "preparation_task"].includes(item.kind)
      ? "event"
      : null);
  const changedFields: string[] = [];
  const warnings = [...(scheduleRange?.warnings ?? dateTime?.warnings ?? [])];

  if (title && title !== item.title) changedFields.push("title");
  if (kind && kind !== item.kind) changedFields.push("kind");
  if (scheduledLocal) changedFields.push("schedule");
  if (deadline || clearDeadline) changedFields.push("deadline");
  if (reminderPolicy) changedFields.push("reminder_policy");
  if (dateTime?.usedNextWeek) warnings.push("weekday_today_time_passed_used_next_week");

  return {
    itemId: item.id,
    ...(title ? { title } : {}),
    ...(kind && kind !== item.kind ? { kind } : {}),
    ...(scheduledLocal
      ? { scheduledForLocal: scheduledLocal.toISO({ suppressMilliseconds: true }) ?? undefined }
      : {}),
    ...(scheduleRange
      ? { endsAtLocal: scheduleRange.endLocal.toISO({ suppressMilliseconds: true }) ?? undefined }
      : {}),
    ...(allDayRange ? { allDay: true } : {}),
    ...(deadline
      ? { deadlineAtLocal: deadline.dueLocal.toISO({ suppressMilliseconds: true }) ?? undefined }
      : {}),
    ...(clearDeadline ? { clearDeadline: true } : {}),
    ...(reminderPolicy ? { reminderPolicy } : {}),
    changedFields: [...new Set(changedFields)],
    warnings: [...new Set(warnings)],
    pastConfirmationRequired:
      scheduleRange?.pastConfirmationRequired ?? dateTime?.pastConfirmationRequired ?? false,
  };
}

function parseReminderWindowMutation(params: {
  text: string;
  range: { startLocal: DateTime; endLocal: DateTime };
}): ItemEditReminderMutation | null {
  if (!/напоминай|напомни|напоминать/i.test(params.text)) return null;
  const intervalMinutes = parseExplicitReminderIntervalMinutes(params.text);
  if (!intervalMinutes || params.range.endLocal <= params.range.startLocal) return null;
  return {
    policyType: "nag_until_ack",
    startsAtLocal: params.range.startLocal.toISO({ suppressMilliseconds: true }) ?? "",
    endsAtLocal: params.range.endLocal.toISO({ suppressMilliseconds: true }) ?? "",
    intervalMinutes,
    activeWindowStart: params.range.startLocal.toFormat("HH:mm"),
    activeWindowEnd: params.range.endLocal.toFormat("HH:mm"),
    stopCondition: "until_done",
  };
}

export async function applyItemEditMutation(params: {
  userId: string;
  item: PlannerItem;
  mutation: ItemEditMutation;
  timezone: string;
  sourceMessageId?: string | null;
  now?: Date;
}): Promise<ItemEditApplyResult> {
  const now = params.now ?? new Date();
  const timezone = params.item.timezone || params.timezone;
  const beforeItem = toItemSnapshot(params.item);
  const beforePolicies = (await listReminderPoliciesForItem(params.userId, params.item.id, 50))
    .filter((policy) => policy.status === "active")
    .map(toPolicySnapshot);

  const update = buildItemUpdate({
    item: params.item,
    mutation: params.mutation,
    timezone,
    now,
  });
  const item =
    Object.keys(update).length > 0
      ? await updatePlannerItemDetails({
          userId: params.userId,
          itemId: params.item.id,
          ...update,
          metadata: {
            mutationSource: "item_edit_session",
            itemEditSourceMessageId: params.sourceMessageId ?? null,
            itemEditUpdatedAt: now.toISOString(),
            ...(params.mutation.allDay ? { allDay: true, timeGranularity: "all_day" } : {}),
          },
        })
      : params.item;

  const policyIds: string[] = [];
  const reminderIds: string[] = [];
  const warnings: string[] = [];

  if (params.mutation.reminderPolicy) {
    const targetItem = item ?? params.item;
    const policyResult =
      params.mutation.reminderPolicy.policyType === "before_event_multi"
        ? await createBeforeEventReminderPolicies({
            userId: params.userId,
            item: targetItem,
            mutation: params.mutation.reminderPolicy,
            timezone,
            now,
          })
        : await upsertNagUntilAckPolicy({
            userId: params.userId,
            item: targetItem,
            mutation: params.mutation.reminderPolicy,
            timezone,
            now,
          });
    policyIds.push(
      ...("policyIds" in policyResult
        ? policyResult.policyIds
        : policyResult.policy
          ? [policyResult.policy.id]
          : []),
    );
    reminderIds.push(
      ...("reminderIds" in policyResult
        ? policyResult.reminderIds
        : policyResult.reminderId
          ? [policyResult.reminderId]
          : []),
    );
    warnings.push(...policyResult.warnings);
  }

  return {
    item,
    policyIds,
    reminderIds,
    warnings: [...new Set([...params.mutation.warnings, ...warnings])],
    undoPayload: {
      items: [beforeItem],
      reminderPolicies: beforePolicies,
      createdPolicyIds: policyIds.filter(
        (policyId) => !beforePolicies.some((policy) => policy.id === policyId),
      ),
    },
  };
}

export function formatItemEditPreview(params: {
  item: PlannerItem;
  mutation: ItemEditMutation;
  timezone: string;
}) {
  const lines = [
    "Проверяю изменение:",
    "",
    "Было:",
    formatItemVariant({
      title: params.item.title,
      startAt: params.item.startAt,
      endAt: params.item.endAt,
      dueAt: params.item.dueAt,
      timezone: params.item.timezone || params.timezone,
    }),
    "",
    "Станет:",
    formatMutationVariant(params),
  ];
  if (params.mutation.reminderPolicy) {
    lines.push(`Напоминания: ${formatReminderMutation(params.mutation.reminderPolicy)}`);
  }
  if (params.mutation.kind) lines.push(`Тип: ${params.mutation.kind}`);
  if (params.mutation.pastConfirmationRequired) {
    lines.push(
      "",
      "Это время уже прошло сегодня. Подтверди, если всё равно нужно поставить в прошлое.",
    );
  }
  if (params.mutation.warnings.length) {
    lines.push("", `Заметки: ${params.mutation.warnings.join(", ")}`);
  }
  lines.push("", "Применить?");
  return lines.join("\n");
}

export function formatItemEditApplied(params: {
  item: PlannerItem;
  mutation: ItemEditMutation;
  timezone: string;
  calendarFeedback?: string | null;
}) {
  const lines = [
    "Готово:",
    formatItemVariant({
      title: params.item.title,
      startAt: params.item.startAt,
      endAt: params.item.endAt,
      dueAt: params.item.dueAt,
      timezone: params.item.timezone || params.timezone,
    }),
  ];
  if (params.mutation.reminderPolicy) {
    lines.push(`• Напоминания: ${formatReminderMutation(params.mutation.reminderPolicy)}`);
  }
  if (params.calendarFeedback) lines.push("", params.calendarFeedback);
  return lines.join("\n");
}

function parseRenamedTitle(text: string) {
  const quoted = text.match(
    /(?:изменить|измени|переименуй|переименовать|назови|назвать)(?:\s+\S+){0,4}?\s+на\s+["«]([^"»]+)["»]/i,
  );
  if (quoted?.[1]) return quoted[1].trim();
  const unquoted = text.match(
    /^(?:изменить|измени|переименуй|переименовать|назови|назвать)(?:\s+(?:название|имя))?\s+(?:на|в)?\s*(.+)$/i,
  );
  if (!unquoted?.[1]) return null;
  return (
    unquoted[1]
      .split(
        /,\s*(?:время|поставь|перенеси|на\s+(?:сегодня|завтра|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|напом)/i,
      )[0]
      ?.trim() || null
  );
}

function parseReminderMutation(params: {
  text: string;
  timezone: string;
  dateTimeLocal: DateTime | null;
  item: PlannerItem;
  now: Date;
}): ItemEditReminderMutation | null {
  const normalized = params.text.toLowerCase().replace(/ё/g, "е");
  const asksReminder = /напоминай|напомни|напоминать/i.test(normalized);
  const beforeEvent = parseBeforeEventMultiReminderMutation(params);
  if (beforeEvent) return beforeEvent;
  const untilDone = normalizeUntilDoneReminder({
    text: params.text,
    timezone: params.timezone,
    now: params.now,
  });
  if (!untilDone || !asksReminder) return null;
  const startLocal =
    params.dateTimeLocal ??
    DateTime.fromJSDate(untilDone.startsAt, { zone: "utc" }).setZone(params.timezone);
  const usesEndOfDayWindow = untilDone.endOfDayExplicit && !params.dateTimeLocal;
  return {
    policyType: "nag_until_ack",
    startsAtLocal: startLocal.toISO({ suppressMilliseconds: true }) ?? "",
    ...(usesEndOfDayWindow
      ? {
          endsAtLocal:
            DateTime.fromJSDate(untilDone.endsAt, { zone: "utc" })
              .setZone(params.timezone)
              .toISO({ suppressMilliseconds: true }) ?? "",
          activeWindowEnd: untilDone.windowEnd,
        }
      : {}),
    intervalMinutes: untilDone.intervalMinutes,
    activeWindowStart: startLocal.toFormat("HH:mm"),
    stopCondition: "until_done",
  };
}

function parseBeforeEventMultiReminderMutation(params: {
  text: string;
  timezone: string;
  item: PlannerItem;
  now: Date;
}): ItemEditReminderMutation | null {
  const anchor = params.item.startAt ?? params.item.dueAt;
  if (!anchor) return null;
  const normalized = params.text.toLocaleLowerCase("ru").replace(/ё/g, "е");
  if (!/(напомни|напоминай|напоминани)/i.test(normalized)) return null;
  if (
    !/за\s+(?:день|пол\s*часа|полчаса|полтора|час|один|одну|два|две|три|\d+\s*(?:час|мин))/i.test(
      normalized,
    )
  )
    return null;
  const parsed = parseBeforeEventReminderSpecsForAnchor({
    text: params.text,
    anchor,
    timezone: params.timezone,
    now: params.now,
    includePast: true,
  });
  if (!parsed.reminders.length) return null;
  return {
    policyType: "before_event_multi",
    reminders: parsed.reminders,
    mode: detectBeforeEventReminderMode(params.text),
    mutationSource: "item_edit_session",
  };
}

function parseAllDaySchedule(params: {
  text: string;
  item: PlannerItem;
  timezone: string;
  now: Date;
}) {
  const normalized = params.text
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
  const asksAllDay =
    /(?:^|\s)(?:целый|весь)\s+день(?:\s|$)/.test(normalized) ||
    /(?:^|\s)на\s+весь\s+день(?:\s|$)/.test(normalized) ||
    /\ball[-\s]?day\b/.test(normalized);
  if (!asksAllDay) return null;
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const anchor = params.item.startAt ?? params.item.dueAt;
  const anchorLocal = anchor
    ? DateTime.fromJSDate(anchor, { zone: "utc" }).setZone(params.timezone)
    : nowLocal;
  const day = /(?:^|\s)завтра(?:\s|$)/.test(normalized)
    ? nowLocal.plus({ days: 1 })
    : /(?:^|\s)сегодня(?:\s|$)/.test(normalized)
      ? nowLocal
      : anchorLocal;
  return {
    startLocal: day.startOf("day"),
    endLocal: day.endOf("day").set({ millisecond: 0 }),
    warnings: [],
    pastConfirmationRequired: false,
  };
}

function inferKind(params: { title: string; currentKind: string }) {
  if (!["task", "preparation_task", "recurring_task"].includes(params.currentKind)) return null;
  if (/(визит|прием|приём|встреча|созвон|эфир|запись|матч)/i.test(params.title)) {
    return "event";
  }
  return null;
}

function buildItemUpdate(params: {
  item: PlannerItem;
  mutation: ItemEditMutation;
  timezone: string;
  now: Date;
}) {
  const update: {
    title?: string;
    kind?: string;
    startAt?: Date | null;
    endAt?: Date | null;
    dueAt?: Date | null;
  } = {};
  if (params.mutation.title) update.title = params.mutation.title;
  const kind = params.mutation.kind ?? params.item.kind;
  if (params.mutation.kind) update.kind = params.mutation.kind;
  if (params.mutation.clearDeadline) update.dueAt = null;
  if (params.mutation.deadlineAtLocal) {
    update.dueAt = DateTime.fromISO(params.mutation.deadlineAtLocal, {
      zone: params.timezone,
    })
      .toUTC()
      .toJSDate();
  }
  if (!params.mutation.scheduledForLocal) return update;

  const local = DateTime.fromISO(params.mutation.scheduledForLocal, {
    zone: params.timezone,
  });
  const startAt = local.toUTC().toJSDate();
  if (params.mutation.allDay) {
    update.startAt = startAt;
    update.endAt = params.mutation.endsAtLocal
      ? DateTime.fromISO(params.mutation.endsAtLocal, { zone: params.timezone }).toUTC().toJSDate()
      : local.endOf("day").toUTC().toJSDate();
    update.dueAt = null;
    if (!update.kind && ["task", "preparation_task"].includes(params.item.kind)) {
      update.kind = "event";
    }
    return update;
  }
  const oldDurationMs =
    params.item.startAt && params.item.endAt
      ? params.item.endAt.getTime() - params.item.startAt.getTime()
      : null;
  const eventLike = ["event", "training", "tentative_event"].includes(kind);
  const mixedTaskSchedule = Boolean(params.mutation.deadlineAtLocal) && !eventLike;
  if (mixedTaskSchedule) {
    update.startAt = startAt;
    update.endAt = params.mutation.endsAtLocal
      ? DateTime.fromISO(params.mutation.endsAtLocal, { zone: params.timezone }).toUTC().toJSDate()
      : oldDurationMs && oldDurationMs > 0
        ? new Date(startAt.getTime() + oldDurationMs)
        : DateTime.fromJSDate(startAt, { zone: "utc" }).plus({ minutes: 60 }).toJSDate();
    return update;
  }
  if (eventLike) {
    update.startAt = startAt;
    update.endAt = params.mutation.endsAtLocal
      ? DateTime.fromISO(params.mutation.endsAtLocal, { zone: params.timezone }).toUTC().toJSDate()
      : oldDurationMs && oldDurationMs > 0
        ? new Date(startAt.getTime() + oldDurationMs)
        : DateTime.fromJSDate(startAt, { zone: "utc" }).plus({ minutes: 60 }).toJSDate();
    update.dueAt = null;
  } else {
    update.startAt = null;
    update.endAt = null;
    update.dueAt = startAt;
  }
  return update;
}

async function upsertNagUntilAckPolicy(params: {
  userId: string;
  item: PlannerItem;
  mutation: Extract<ItemEditReminderMutation, { policyType: "nag_until_ack" }>;
  timezone: string;
  now: Date;
}) {
  const startsAt = DateTime.fromISO(params.mutation.startsAtLocal, { zone: params.timezone })
    .toUTC()
    .toJSDate();
  const endsAt = params.mutation.endsAtLocal
    ? DateTime.fromISO(params.mutation.endsAtLocal, { zone: params.timezone }).toUTC().toJSDate()
    : null;
  const active = (await listReminderPoliciesForItem(params.userId, params.item.id, 20)).find(
    (policy) => policy.status === "active" && policy.policyType === "nag_until_ack",
  );
  const metadata = {
    mutationSource: "item_edit_session",
    stopCondition: params.mutation.stopCondition,
    activeWindowStart: params.mutation.activeWindowStart,
    activeWindowEnd: params.mutation.activeWindowEnd ?? null,
    stopOnItemComplete: true,
  };
  const policy = active
    ? await updateReminderPolicy({
        policyId: active.id,
        userId: params.userId,
        title: params.item.title,
        category: params.item.category ?? "item_edit",
        policyType: "nag_until_ack",
        startsAt,
        endsAt,
        nextFireAt: startsAt,
        intervalMinutes: params.mutation.intervalMinutes,
        requireAck: true,
        catchUpMode: "one_immediate_then_resume",
        onWindowEnd: "keep_open",
        metadata,
      })
    : await createReminderPolicyIfMissing({
        userId: params.userId,
        itemId: params.item.id,
        title: params.item.title,
        category: params.item.category ?? "item_edit",
        policyType: "nag_until_ack",
        timezone: params.item.timezone || params.timezone,
        startsAt,
        endsAt,
        nextFireAt: startsAt,
        intervalMinutes: params.mutation.intervalMinutes,
        requireAck: true,
        catchUpMode: "one_immediate_then_resume",
        onWindowEnd: "keep_open",
        idempotencyKey: `${params.item.id}:item-edit:nag-until-ack:${startsAt.toISOString()}`,
        metadata,
      });
  if (!policy) return { policy: null, reminderId: null, warnings: ["policy_update_failed"] };
  await cancelPendingRemindersForPolicy({
    userId: params.userId,
    policyId: policy.id,
    from: params.now,
  });
  const reminder =
    startsAt > params.now
      ? await materializeNextPolicyReminder(policy, startsAt, { now: params.now })
      : null;
  return {
    policy,
    reminderId: reminder?.id ?? null,
    warnings: startsAt <= params.now ? ["reminder_start_in_past_not_materialized"] : [],
  };
}

async function createBeforeEventReminderPolicies(params: {
  userId: string;
  item: PlannerItem;
  mutation: Extract<ItemEditReminderMutation, { policyType: "before_event_multi" }>;
  timezone: string;
  now: Date;
}) {
  const policyIds: string[] = [];
  const reminderIds: string[] = [];
  const warnings: string[] = [];
  const timezone = params.item.timezone || params.timezone;
  const mutationSource = params.mutation.mutationSource ?? "item_edit_session";
  if (params.mutation.mode === "replace") {
    const existing = (await listReminderPoliciesForItem(params.userId, params.item.id, 100)).filter(
      (policy) => policy.status === "active" && policy.policyType === "before_event",
    );
    for (const policy of existing) {
      await cancelPendingRemindersForPolicy({
        userId: params.userId,
        policyId: policy.id,
        from: params.now,
      });
      await updateReminderPolicy({
        userId: params.userId,
        policyId: policy.id,
        status: "cancelled",
        nextFireAt: null,
        metadata: {
          replacedByMultiReminderAt: params.now.toISOString(),
          replacementSource: mutationSource,
        },
      });
    }
  }
  for (const reminder of params.mutation.reminders) {
    const fireAt = DateTime.fromISO(reminder.fireAtLocal, { zone: timezone }).toUTC().toJSDate();
    const policy = await createReminderPolicyIfMissing({
      userId: params.userId,
      itemId: params.item.id,
      title: params.item.title,
      category: "pre_event",
      policyType: "before_event",
      timezone,
      startsAt: fireAt,
      nextFireAt: fireAt,
      recurrenceRule: null,
      intervalMinutes: null,
      requireAck: false,
      catchUpMode: "one_immediate_then_resume",
      onWindowEnd: "expire_silently",
      idempotencyKey: `${params.item.id}:before-event:${reminder.minutesBefore}:${fireAt.toISOString()}`,
      metadata: {
        mutationSource,
        reminderMode: params.mutation.mode,
        minutesBefore: reminder.minutesBefore,
        relativeLabel: reminder.label,
      },
    });
    policyIds.push(policy.id);
    if (fireAt <= params.now) {
      warnings.push(`before_event_in_past:${reminder.label}`);
      continue;
    }
    const materialized = await materializeNextPolicyReminder(policy, fireAt, { now: params.now });
    if (materialized) reminderIds.push(materialized.id);
  }
  return {
    policy: policyIds.length ? { id: policyIds[0] } : null,
    policyIds,
    reminderIds,
    reminderId: reminderIds[0] ?? null,
    warnings,
  };
}

function formatItemVariant(params: {
  title: string;
  startAt: Date | null;
  endAt: Date | null;
  dueAt: Date | null;
  timezone: string;
}) {
  const schedule = params.startAt
    ? formatRuWeekdayDateRange(params.startAt, params.endAt, params.timezone)
    : "запланированного времени нет";
  const deadline = params.dueAt
    ? `дедлайн ${formatDeadlineDateTime(params.dueAt, params.timezone)}`
    : "без дедлайна";
  return `${params.title} — ${schedule}; ${deadline}`;
}

function formatReminderMutation(mutation: ItemEditReminderMutation) {
  if (mutation.policyType === "before_event_multi") {
    const action = mutation.mode === "replace" ? "заменить на" : "добавить";
    return `${action}: ${mutation.reminders.map((reminder) => reminder.label).join(", ")}`;
  }
  return `каждый час с ${mutation.activeWindowStart}, пока не отметишь готово`;
}

function formatMutationVariant(params: {
  item: PlannerItem;
  mutation: ItemEditMutation;
  timezone: string;
}) {
  const timezone = params.item.timezone || params.timezone;
  const start = params.mutation.scheduledForLocal
    ? DateTime.fromISO(params.mutation.scheduledForLocal, { zone: timezone }).toUTC().toJSDate()
    : params.item.startAt;
  const end = params.mutation.endsAtLocal
    ? DateTime.fromISO(params.mutation.endsAtLocal, { zone: timezone }).toUTC().toJSDate()
    : params.item.endAt;
  const dueAt = params.mutation.clearDeadline
    ? null
    : params.mutation.deadlineAtLocal
      ? DateTime.fromISO(params.mutation.deadlineAtLocal, { zone: timezone }).toUTC().toJSDate()
      : params.item.dueAt;
  return formatItemVariant({
    title: params.mutation.title ?? params.item.title,
    startAt: start,
    endAt: end,
    dueAt,
    timezone,
  });
}

function toItemSnapshot(item: PlannerItem) {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    description: item.description,
    location: item.location,
    timezone: item.timezone,
    startAt: item.startAt?.toISOString() ?? null,
    endAt: item.endAt?.toISOString() ?? null,
    dueAt: item.dueAt?.toISOString() ?? null,
    completedAt: item.completedAt?.toISOString() ?? null,
    cancelledAt: item.cancelledAt?.toISOString() ?? null,
    archivedAt: item.archivedAt?.toISOString() ?? null,
    category: item.category,
    visibility: item.visibility,
    priority: item.priority,
    metadata: item.metadata,
  };
}

function toPolicySnapshot(policy: ReminderPolicy) {
  return {
    id: policy.id,
    itemId: policy.itemId,
    title: policy.title,
    category: policy.category,
    policyType: policy.policyType,
    status: policy.status,
    timezone: policy.timezone,
    startsAt: policy.startsAt?.toISOString() ?? null,
    endsAt: policy.endsAt?.toISOString() ?? null,
    nextFireAt: policy.nextFireAt?.toISOString() ?? null,
    recurrenceRule: policy.recurrenceRule,
    intervalMinutes: policy.intervalMinutes,
    requireAck: policy.requireAck,
    catchUpMode: policy.catchUpMode,
    onWindowEnd: policy.onWindowEnd,
    metadata: policy.metadata,
  };
}
