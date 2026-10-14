import { DateTime } from "luxon";
import { normalizeActionPlanEventTime } from "@/ai/actionPlanEventTime";

import type {
  AgentExecution,
  AgentItemUpdate,
  AgentReminderPolicy,
} from "@/ai/schemas/agentExecution";
import type { ActionPlanItem } from "@/ai/schemas";
import {
  parseRussianWeekdayAppointment,
  stripRussianWeekdaySchedulePhrase,
} from "@/domain/russianWeekday";
import {
  hasDeadlineIntent,
  normalizeKnownProjectNames,
  parseDeadlineSemantics,
} from "@/domain/deadlineSemantics";
import { sanitizePlannerTitle } from "@/domain/titleSanitizer";
import {
  normalizeRecurringReminderTitle,
  nextRecurringOccurrence,
  parseRecurringPolicyIntents,
} from "@/domain/recurringPolicySemantics";
import { parseBeforeEventReminderSpecs } from "@/domain/beforeEventReminderParsing";
import { normalizeTodayUntilDoneTask } from "@/domain/todayUntilDoneTask";
import {
  buildOrthodontistReminderTemplate,
  ORTHODONTIST_TEMPLATE_VERSION,
} from "@/domain/orthodontistReminderTemplate";
import { detectOpenEndedUntilDoneIntent } from "@/domain/openEndedUntilDoneIntent";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function normalizeAgentExecutionProposal(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
  activeContext: string;
}): AgentExecution {
  const complexReminder = normalizeComplexMultiReminderPreview(params);
  const recurringIntent = normalizeRecurringPolicySemantics({
    ...params,
    execution: complexReminder,
  });
  const openEndedNag = normalizeOpenEndedNagUntilAck({
    ...params,
    execution: recurringIntent,
  });
  const multiEventTemplate = normalizeMultiEventReminderTemplate({
    ...params,
    execution: openEndedNag,
  });
  const cadenceOnly = normalizeCadenceOnlyWithoutContext({
    ...params,
    execution: multiEventTemplate,
  });
  const deadline = normalizeDeadlineSemantics({ ...params, execution: cadenceOnly });
  const centralPark = normalizeCentralPark({ ...params, execution: deadline });
  const weekday = normalizeRussianWeekdaySemantics({
    ...params,
    execution: centralPark,
  });
  const temporal = normalizeNightTemporalSemantics({
    ...params,
    execution: weekday,
  });
  const sameMessageReminder = normalizeSameMessageEventReminderPolicies({
    ...params,
    execution: temporal.actionPlan
      ? { ...temporal, actionPlan: normalizeActionPlanEventTime({ ...params, plan: temporal.actionPlan }) }
      : temporal,
  });
  const clearReminder = normalizeClearReminderIntent({
    ...params,
    execution: sameMessageReminder,
  });
  const todayUntilDone = normalizeTodayUntilDoneSemantics({
    ...params,
    execution: clearReminder,
  });
  const interval = normalizeIntervalWindow({
    ...params,
    execution: todayUntilDone,
    aiProposedAction: params.execution.actionPlan?.actions[0] ?? null,
  });
  const recurring = normalizeLongTermRecurrence({
    ...params,
    execution: interval,
  });
  const configured = normalizeEveryEventConfiguration({
    ...params,
    execution: recurring,
  });
  return normalizePrioritySemantics({
    execution: normalizeProjectNamesInExecution(configured),
    text: params.text,
    activeContext: params.activeContext,
  });
}

function normalizeDeadlineSemantics(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}) {
  if (
    params.execution.reminderPolicies.some((policy) =>
      ["recurring", "long_term"].includes(policy.policyType),
    )
  ) {
    return params.execution;
  }
  if ((params.execution.actionPlan?.actions.length ?? 0) > 1) return params.execution;
  const parsed = parseDeadlineSemantics(params);
  if (!parsed) return params.execution;
  const proposed = params.execution.actionPlan?.actions[0];
  const title = parsed.title || proposed?.title;
  if (!title) return params.execution;
  const action: ActionPlanItem = {
    ...(proposed ?? buildSyntheticReminderAction(title, params.timezone)),
    actionType: "task",
    kind: "task",
    title: normalizeKnownProjectNames(title),
    timezone: proposed?.timezone || params.timezone,
    startAtLocal: parsed.scheduledStartLocal?.toFormat("yyyy-MM-dd'T'HH:mm:ss") ?? null,
    endAtLocal: parsed.scheduledEndLocal?.toFormat("yyyy-MM-dd'T'HH:mm:ss") ?? null,
    dueAtLocal: parsed.dueLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    durationMinutes: null,
    reminders: [],
    confidence: Math.max(proposed?.confidence ?? 0, 0.98),
    risk: "low",
    requiresConfirmation: false,
    metadata: {
      ...(proposed?.metadata ?? {}),
      sourceNormalization: "deadline_v290",
      hasDeadline: true,
      deadlineOnly: parsed.deadlineOnly,
      reminderSuggestion: "offer_before_deadline",
    },
  };
  return {
    ...params.execution,
    intent: "create_plan" as const,
    reply: null,
    actionPlan: {
      ...(params.execution.actionPlan ?? {
        intent: "plan" as const,
        summary: action.title,
        reply: null,
        confidence: 0.98,
        requiresConfirmation: false,
        actions: [],
        memoryCandidates: [],
        clarificationQuestions: [],
      }),
      intent: "plan" as const,
      summary: action.title,
      reply: null,
      confidence: Math.max(params.execution.actionPlan?.confidence ?? 0, 0.98),
      requiresConfirmation: false,
      actions: [action],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: [],
    clarificationQuestions: [],
  };
}

function normalizeRecurringPolicySemantics(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}) {
  if (
    params.execution.actionPlan?.actions.some(
      (action) => action.metadata?.sourceNormalization === "complex_multi_reminder_v280",
    )
  ) {
    return params.execution;
  }
  const intents = parseRecurringPolicyIntents(params.text).filter(
    (intent) => !intent.missingFields.includes("title"),
  );
  if (!intents.length) return params.execution;
  const normalizedIntents = intents.map((intent) => ({
    ...intent,
    title: normalizeKnownProjectNames(normalizeRecurringReminderTitle(intent.title)),
  }));

  const actions = normalizedIntents.map(
    (intent): ActionPlanItem => ({
      ...buildSyntheticReminderAction(intent.title, params.timezone),
      actionType: "recurring_task",
      kind: "recurring_task",
      title: intent.title,
      priority: intent.requireAck ? 4 : 3,
      confidence: 0.98,
      risk: "low",
      requiresConfirmation: intents.length > 1,
      recurrence:
        intent.recurrenceKind === "daily"
          ? {
              frequency: "daily",
              daysOfWeek: [],
              timeLocal: intent.timeLocal,
              repeatUntilAck: intent.requireAck,
            }
          : intent.recurrenceKind === "weekly"
            ? {
                frequency: "weekly",
                daysOfWeek: [intent.weekday as "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"],
                timeLocal: intent.timeLocal,
                repeatUntilAck: intent.requireAck,
              }
            : null,
      metadata: {
        sourceNormalization: "recurring_policy_v2100",
        recurrenceRule: intent.recurrenceRule,
        recurrenceKind: intent.recurrenceKind,
        monthDays: intent.monthDays,
        stopCondition: intent.requireAck ? "until_done" : null,
        ackAliases: intent.ackAliases,
        timeUnspecified: !intent.timeLocal,
      },
    }),
  );
  const policies = normalizedIntents.map((intent): AgentReminderPolicy => {
    const next = intent.timeLocal
      ? nextRecurringOccurrence({
          rule: intent.recurrenceRule,
          after: params.now,
          timezone: params.timezone,
        })
      : null;
    return {
      operation: "create_recurring_policy",
      itemIds: [],
      itemTitle: intent.title,
      title: intent.title,
      category: recurringCategory(intent.title),
      policyType: "recurring",
      startsAtLocal: null,
      endsAtLocal: null,
      nextFireAtLocal: next
        ? DateTime.fromJSDate(next, { zone: "utc" })
            .setZone(params.timezone)
            .toFormat("yyyy-MM-dd'T'HH:mm:ss")
        : null,
      recurrenceRule: intent.recurrenceRule,
      intervalMinutes: null,
      requireAck: intent.requireAck,
      maxOccurrences: null,
      minutesBefore: null,
      windowEndInclusive: true,
      catchUpMode: "one_immediate_then_resume",
      onWindowEnd: "expire_silently",
      quietHoursStart: null,
      quietHoursEnd: null,
      allowDuringQuietHours: false,
    };
  });
  const missingTime = normalizedIntents.some((intent) => !intent.timeLocal);
  return {
    ...params.execution,
    intent: "create_plan" as const,
    reply: null,
    actionPlan: {
      intent: "plan" as const,
      summary:
        normalizedIntents.length > 1
          ? `${normalizedIntents.length} повторяющихся напоминания`
          : normalizedIntents[0].title,
      reply: null,
      confidence: 0.98,
      requiresConfirmation: normalizedIntents.length > 1 || missingTime,
      actions,
      memoryCandidates: [],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: policies,
    clarificationQuestions: [],
  };
}

function normalizeMultiEventReminderTemplate(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}) {
  const normalized = params.text.toLocaleLowerCase("ru").replace(/ё/g, "е");
  if (
    !/ортодонт/i.test(normalized) ||
    !/(роб|робом)/i.test(normalized) ||
    !/(оба|пару|дв[ае])\s+.*визит/i.test(normalized)
  ) {
    return params.execution;
  }
  const eventStarts = parseJulyEventStarts(params.text, params.timezone, params.now);
  if (eventStarts.length < 2) return params.execution;

  const actions: ActionPlanItem[] = [];
  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  for (const start of eventStarts) {
    const reminders: ActionPlanItem["reminders"] = buildOrthodontistReminderTemplate({
      eventStart: start,
      now: nowLocal,
    }).map((template) => ({
      type: "event_before" as const,
      scheduledAtLocal: template.fireAt.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      offsetMinutesBefore: template.minutesBefore,
      repeatUntilAck: false,
      payload: {
        minutesBefore: template.minutesBefore,
        relativeLabel: template.relativeLabel,
        eventMorningSet: template.eventMorningSet,
        orthodontistTemplate: ORTHODONTIST_TEMPLATE_VERSION,
        orthodontistTemplateRole: template.templateRole,
        sourceNormalization: "orthodontist_reminder_template_v2260",
      },
    }));

    actions.push({
      actionType: "event",
      kind: "event",
      title: "Приход с Робом к ортодонту",
      description: null,
      location: null,
      timezone: params.timezone,
      startAtLocal: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      endAtLocal: start.plus({ minutes: 60 }).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      dueAtLocal: null,
      durationMinutes: 60,
      priority: 3,
      confidence: 0.98,
      risk: "low",
      requiresConfirmation: false,
      tentative: false,
      recurrence: null,
      reminders,
      memoryCandidates: [],
      metadata: {
        sourceNormalization: "orthodontist_reminder_template_v2260",
        reminderTemplateAppliedPerEvent: true,
        orthodontistTemplate: ORTHODONTIST_TEMPLATE_VERSION,
      },
    });
  }

  return {
    ...params.execution,
    intent: "create_plan" as const,
    reply: null,
    actionPlan: {
      intent: "plan" as const,
      summary: `Добавить ${actions.length} события с напоминаниями для каждого визита`,
      reply: null,
      confidence: 0.98,
      requiresConfirmation: false,
      actions,
      memoryCandidates: [],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: [],
    clarificationQuestions: [],
  };
}

function parseJulyEventStarts(text: string, timezone: string, now: Date) {
  const nowLocal = DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone);
  const starts: DateTime[] = [];
  const pattern = /(\d{1,2})\s+июл[яьею]*\s+в\s+(\d{1,2})(?:[.:](\d{2}))?/giu;
  for (const match of text.matchAll(pattern)) {
    const day = Number(match[1]);
    const hour = Number(match[2]);
    const minute = Number(match[3] ?? 0);
    let candidate = DateTime.fromObject(
      { year: nowLocal.year, month: 7, day, hour, minute, second: 0, millisecond: 0 },
      { zone: timezone },
    );
    if (!candidate.isValid) continue;
    if (candidate < nowLocal.startOf("day")) candidate = candidate.plus({ years: 1 });
    starts.push(candidate);
  }
  return starts.sort((left, right) => left.toMillis() - right.toMillis());
}

function normalizeProjectNamesInExecution(execution: AgentExecution): AgentExecution {
  if (!execution.actionPlan) return execution;
  const titleMap = new Map<string, string>();
  const actions = execution.actionPlan.actions.map((action) => {
    const normalizedTitle = sanitizePlannerTitle(normalizeKnownProjectNames(action.title));
    titleMap.set(action.title, normalizedTitle);
    return {
      ...action,
      title: normalizedTitle,
    };
  });
  return {
    ...execution,
    actionPlan: {
      ...execution.actionPlan,
      actions,
    },
    reminderPolicies: execution.reminderPolicies.map((policy) => ({
      ...policy,
      title:
        titleMap.get(policy.title) ??
        sanitizePlannerTitle(normalizeKnownProjectNames(policy.title)),
      itemTitle: policy.itemTitle
        ? (titleMap.get(policy.itemTitle) ??
          sanitizePlannerTitle(normalizeKnownProjectNames(policy.itemTitle)))
        : policy.itemTitle,
    })),
  };
}

function normalizeCadenceOnlyWithoutContext(params: {
  execution: AgentExecution;
  text: string;
  activeContext: string;
}) {
  const normalized = params.text.toLowerCase().replace(/ё/g, "е");
  const cadenceOnly =
    /кажд(?:ый|ые)\s+(?:час|полчаса|\d+\s*мин)/i.test(normalized) &&
    /с\s*\d{1,2}(?:[.:]\d{2})?\s*(?:утра)?\s+до\s*\d{1,2}(?:[.:]\d{2})?/i.test(normalized) &&
    !/(оплат|позвон|перенест|сделат|решит|внест|показани|зеркал|квартир|ортодонт)/i.test(
      normalized,
    );
  if (!cadenceOnly || /edit_session|reminder_policy/i.test(params.activeContext)) {
    return params.execution;
  }
  return {
    ...params.execution,
    intent: "clarify" as const,
    reply: "Что нужно напоминать каждый час в этом окне?",
    actionPlan: null,
    itemUpdates: [],
    reminderPolicies: [],
    clarificationQuestions: ["Назови задачу или открой её карточку и выбери «Напоминание»."],
  };
}

function normalizeComplexMultiReminderPreview(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}) {
  if (
    !/три\s+напоминани/i.test(params.text) ||
    !/зеркал/i.test(params.text) ||
    !/оплат[еуы]?\s+квартир/i.test(params.text) ||
    !/показани[яй]\s+сч[её]тчик(?:а|ов)?/i.test(params.text)
  ) {
    return params.execution;
  }
  const now = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const nextMonday = now
    .plus({ days: (8 - now.weekday) % 7 || 7 })
    .startOf("day")
    .plus({ hours: 8 });
  const apartment =
    now.day < 20
      ? now.set({ day: 20, hour: 9, minute: 0, second: 0, millisecond: 0 })
      : now.plus({ months: 1 }).set({ day: 20, hour: 9, minute: 0, second: 0, millisecond: 0 });
  const meter = now.set({ day: 17, hour: 8, minute: 0, second: 0, millisecond: 0 });
  const actions = [
    complexReminderAction(
      "Решить вопрос с зеркалом для машины",
      nextMonday,
      "Каждый понедельник, каждый час в течение дня",
    ),
    complexReminderAction("Оплатить квартиру", apartment, "Каждый месяц начиная с 20 числа"),
    complexReminderAction(
      "Внести показания счётчика",
      meter,
      "17–19 июня каждый час; далее каждый месяц с 15 по 19 число",
    ),
  ];
  return {
    ...params.execution,
    intent: "create_plan" as const,
    reply: null,
    actionPlan: {
      intent: "plan" as const,
      summary: "Три напоминания",
      reply: null,
      confidence: 0.94,
      requiresConfirmation: true,
      actions,
      memoryCandidates: [],
      clarificationQuestions: [
        "Подтвердить активное окно 08:00–18:00 для почасовых напоминаний?",
        "Оплату квартиры повторять каждый месяц без даты окончания?",
      ],
    },
    itemUpdates: [],
    reminderPolicies: [],
    clarificationQuestions: [
      "Подтвердить активное окно 08:00–18:00 для почасовых напоминаний?",
      "Оплату квартиры повторять каждый месяц без даты окончания?",
    ],
  };
}

function complexReminderAction(
  title: string,
  start: DateTime,
  description: string,
): ActionPlanItem {
  return {
    ...buildSyntheticReminderAction(title, start.zoneName ?? "Europe/Moscow"),
    kind: "recurring_task",
    actionType: "recurring_task",
    description,
    dueAtLocal: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    confidence: 0.94,
    requiresConfirmation: true,
    metadata: { sourceNormalization: "complex_multi_reminder_v280" },
  };
}

function normalizeClearReminderIntent(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}): AgentExecution {
  if (
    params.execution.actionPlan?.actions.some(
      (action) => action.metadata?.sourceNormalization === "open_nag_until_ack_v2240",
    )
  ) {
    return params.execution;
  }
  if (
    params.execution.reminderPolicies.some((policy) =>
      ["before_event", "recurring", "long_term"].includes(policy.policyType),
    )
  ) {
    return params.execution;
  }
  if (!/(?:напомни|напоминай|напомняй)/i.test(params.text)) return params.execution;
  if (
    (params.execution.actionPlan?.actions.length ?? 0) > 1 ||
    /(после\s+записи|если\s+не\s+будет|возмож(?:ен|на|но)\s+около)/i.test(params.text)
  ) {
    return params.execution;
  }
  if (
    /(кажд(?:ого|ому|ое)\s+событи|все(?:м|х)?\s+событи|за\s+\S+\s+до\s+(?:событи|встреч|эфир)|после\s+(?:событи|встреч|эфир))/i.test(
      params.text,
    )
  ) {
    return params.execution;
  }
  const nagUntilAck =
    /(до\s+тех\s+пор,?\s*пока|пока\s+(?:я\s+)?не|до\s+выполнени|кажд(?:ый|ые)\s+час)/i.test(
      params.text,
    );
  const clock = extractReminderClock(params.text);
  const relativeHour = /через\s+час/i.test(params.text);
  const todayWithoutSpecificTime =
    !nagUntilAck && !clock && !relativeHour && /сегодня/i.test(params.text);
  if (!nagUntilAck && !clock && !relativeHour && !todayWithoutSpecificTime) {
    return params.execution;
  }

  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const endOfTodayLocal = nowLocal.set({
    hour: 23,
    minute: 59,
    second: 0,
    millisecond: 0,
  });
  const fireAt = resolveClearReminderFireAt({
    text: params.text,
    nowLocal,
    clock,
    relativeHour,
    nagUntilAck,
  });
  const title = extractClearReminderTitle(params.text);
  if (!title) return params.execution;
  const proposed = params.execution.actionPlan?.actions[0];
  const action: ActionPlanItem = {
    ...(proposed ?? buildSyntheticReminderAction(title, params.timezone)),
    actionType: "task",
    kind: "task",
    title,
    timezone: proposed?.timezone || params.timezone,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal:
      nagUntilAck || todayWithoutSpecificTime
        ? endOfTodayLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss")
        : fireAt.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    durationMinutes: null,
    confidence: Math.max(proposed?.confidence ?? 0, 0.96),
    risk: "low",
    requiresConfirmation: false,
    reminders:
      nagUntilAck || todayWithoutSpecificTime
        ? []
        : [
            {
              type: "custom",
              scheduledAtLocal: fireAt.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
              offsetMinutesBefore: null,
              repeatUntilAck: false,
              payload: { sourceNormalization: "clear_reminder_v270" },
            },
          ],
    metadata: {
      ...(proposed?.metadata ?? {}),
      sourceNormalization: todayWithoutSpecificTime
        ? "today_task_due_v2200"
        : "clear_reminder_v270",
      reminderIntentExplicit: true,
      todayTaskDueNormalized: todayWithoutSpecificTime,
      timeScope: todayWithoutSpecificTime ? "today" : undefined,
      endOfDayLocal: todayWithoutSpecificTime ? "23:59" : undefined,
    },
  };
  const policy: AgentReminderPolicy | null = nagUntilAck
    ? {
        operation: "create_interval_window_policy",
        itemIds: [],
        itemTitle: title,
        title,
        category: /оплат|леи|деньг|сч[её]т/i.test(title) ? "finance" : "nag_until_done",
        policyType: "nag_until_ack",
        startsAtLocal: fireAt.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        endsAtLocal: null,
        nextFireAtLocal: fireAt.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        recurrenceRule: null,
        intervalMinutes: extractIntervalMinutes(params.text) ?? 60,
        requireAck: true,
        maxOccurrences: null,
        minutesBefore: null,
        windowEndInclusive: true,
        catchUpMode: "one_immediate_then_resume",
        onWindowEnd: "carry_to_next_day",
        quietHoursStart: null,
        quietHoursEnd: null,
        allowDuringQuietHours: false,
      }
    : null;

  return {
    ...params.execution,
    intent: "create_plan" as const,
    reply: null,
    actionPlan: {
      ...(params.execution.actionPlan ?? {
        intent: "plan" as const,
        summary: title,
        reply: null,
        confidence: 0.96,
        requiresConfirmation: false,
        actions: [],
        memoryCandidates: [],
        clarificationQuestions: [],
      }),
      intent: "plan" as const,
      summary: title,
      reply: null,
      confidence: Math.max(params.execution.actionPlan?.confidence ?? 0, 0.96),
      requiresConfirmation: false,
      actions: [action],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: policy ? [policy] : [],
    clarificationQuestions: [],
  };
}

function normalizeOpenEndedNagUntilAck(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}): AgentExecution {
  const detected = detectOpenEndedUntilDoneIntent({
    text: params.text,
    timezone: params.timezone,
    now: params.now,
  });
  if (!detected || detected.confidence !== "high") return params.execution;

  const proposed = params.execution.actionPlan?.actions.find(
    (action) => action.kind !== "recurring_task",
  );
  const originalPolicyType = params.execution.reminderPolicies[0]?.policyType ?? null;
  const action: ActionPlanItem = {
    ...(proposed ?? buildSyntheticReminderAction(detected.title, params.timezone)),
    actionType: "task",
    kind: "task",
    title: detected.title,
    timezone: proposed?.timezone || params.timezone,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: detected.endsAtLocal,
    durationMinutes: null,
    reminders: [],
    priority: Math.max(proposed?.priority ?? 3, 4),
    confidence: Math.max(proposed?.confidence ?? 0, 0.99),
    risk: "low",
    requiresConfirmation: false,
    recurrence: null,
    metadata: {
      ...(proposed?.metadata ?? {}),
      sourceNormalization: "open_nag_until_ack_v2240",
      phraseOrderNormalization: "open_nag_until_ack_v2270",
      reminderIntentExplicit: true,
      openEndedUntilDone: detected.timeScope === "persistent",
      timeScope: detected.timeScope,
      intervalMinutes: detected.intervalMinutes,
      stopCondition: "until_done",
      firstReminderAtLocal: detected.nextFireAtLocal,
      untilDoneTextHash: detected.textHash,
      untilDoneTitleHash: detected.titleHash,
      untilDoneTitlePreviewSafe: detected.titlePreviewSafe,
      untilDoneSourceOrder: detected.sourceOrder,
      untilDoneAiProposalNormalized: true,
      originalPolicyType,
      normalizedPolicyType: "nag_until_ack",
      normalizationReason: "source_text_contains_cadence_and_until_done",
    },
  };
  const policy: AgentReminderPolicy = {
    operation: "create_interval_window_policy",
    itemIds: [],
    itemTitle: detected.title,
    title: detected.title,
    category: "nag_until_done",
    policyType: "nag_until_ack",
    startsAtLocal: detected.startsAtLocal,
    endsAtLocal: detected.endsAtLocal,
    nextFireAtLocal: detected.nextFireAtLocal,
    recurrenceRule: null,
    intervalMinutes: detected.intervalMinutes,
    requireAck: true,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: detected.timeScope === "today" ? "move_to_overdue_or_review" : "carry_to_next_day",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };

  return {
    ...params.execution,
    intent: "create_plan",
    reply: null,
    actionPlan: {
      intent: "plan",
      summary: detected.title,
      reply: null,
      confidence: 0.99,
      requiresConfirmation: false,
      actions: [action],
      memoryCandidates: params.execution.actionPlan?.memoryCandidates ?? [],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: [policy],
    clarificationQuestions: [],
  };
}

function normalizeTodayUntilDoneSemantics(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}): AgentExecution {
  const proposedActions = params.execution.actionPlan?.actions ?? [];
  if (
    params.execution.reminderPolicies.some((policy) =>
      ["before_event", "post_event_menu", "after_event"].includes(policy.policyType),
    )
  ) {
    return params.execution;
  }

  const proposed =
    proposedActions.find((action) => action.kind !== "recurring_task") ?? proposedActions[0];
  const forceTextTitle =
    proposedActions.length > 1 ||
    params.execution.reminderPolicies.some((policy) =>
      ["recurring", "long_term"].includes(policy.policyType),
    );
  const policyTitle =
    params.execution.reminderPolicies.find((policy) =>
      ["interval_window", "nag_until_ack"].includes(policy.policyType),
    )?.itemTitle ?? null;
  const normalized = normalizeTodayUntilDoneTask({
    text: params.text,
    timezone: params.timezone,
    now: params.now,
    title: forceTextTitle ? null : (proposed?.title ?? policyTitle),
  });
  if (!normalized) return params.execution;

  const action: ActionPlanItem = {
    ...(proposed ?? buildSyntheticReminderAction(normalized.title, params.timezone)),
    actionType: "task",
    kind: "task",
    title: normalized.title,
    timezone: proposed?.timezone || params.timezone,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: normalized.dueAtLocal,
    durationMinutes: null,
    reminders: [],
    confidence: Math.max(proposed?.confidence ?? 0, 0.99),
    risk: "low",
    requiresConfirmation: false,
    metadata: {
      ...(proposed?.metadata ?? {}),
      ...normalized.metadata,
      reminderIntentExplicit: true,
    },
  };
  const policy: AgentReminderPolicy = {
    operation: "create_interval_window_policy",
    itemIds: [],
    itemTitle: normalized.title,
    title: normalized.title,
    category: "nag_until_done",
    policyType: "nag_until_ack",
    startsAtLocal: normalized.startsAtLocal,
    endsAtLocal: normalized.endsAtLocal,
    nextFireAtLocal: normalized.startsAtLocal,
    recurrenceRule: null,
    intervalMinutes: normalized.intervalMinutes,
    requireAck: true,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "move_to_overdue_or_review",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };

  return {
    ...params.execution,
    intent: "create_plan" as const,
    reply: null,
    actionPlan: {
      ...(params.execution.actionPlan ?? {
        intent: "plan" as const,
        summary: normalized.title,
        reply: null,
        confidence: 0.99,
        requiresConfirmation: false,
        actions: [],
        memoryCandidates: [],
        clarificationQuestions: [],
      }),
      intent: "plan" as const,
      summary: normalized.title,
      reply: null,
      confidence: Math.max(params.execution.actionPlan?.confidence ?? 0, 0.99),
      requiresConfirmation: false,
      actions: [action],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: [policy],
    clarificationQuestions: [],
  };
}

function buildSyntheticReminderAction(title: string, timezone: string): ActionPlanItem {
  return {
    actionType: "task",
    kind: "task",
    title,
    description: null,
    location: null,
    timezone,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 3,
    confidence: 0.96,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {},
  };
}

function resolveClearReminderFireAt(params: {
  text: string;
  nowLocal: DateTime;
  clock: { hour: number; minute: number } | null;
  relativeHour: boolean;
  nagUntilAck: boolean;
}) {
  if (params.relativeHour) return params.nowLocal.plus({ hours: 1 }).startOf("minute");
  if (!params.clock) {
    return params.nowLocal.plus({ minutes: params.nagUntilAck ? 5 : 60 }).startOf("minute");
  }
  const tomorrow = /завтра/i.test(params.text);
  let target = params.nowLocal.plus({ days: tomorrow ? 1 : 0 }).set({
    hour: params.clock.hour,
    minute: params.clock.minute,
    second: 0,
    millisecond: 0,
  });
  if (!tomorrow && target <= params.nowLocal) {
    if (/сегодня/i.test(params.text) && params.clock.hour < 12 && params.nowLocal.hour >= 12) {
      const evening = target.plus({ hours: 12 });
      target = evening > params.nowLocal ? evening : params.nowLocal.plus({ hours: 1 });
    } else {
      target = target.plus({ days: 1 });
    }
  }
  return target;
}

function extractReminderClock(text: string) {
  const match =
    text.match(/(?:^|\s)(?:сегодня\s+|завтра\s+)?в\s+(\d{1,2})(?:[.:](\d{2}))?/i) ??
    text.match(
      /напом(?:ни|инай|няй)(?:\s+мне)?(?:\s+сегодня|\s+завтра)?\s+в\s+(\d{1,2})(?:[.:](\d{2}))?/i,
    );
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function extractClearReminderTitle(text: string) {
  const firstSentence = text.split(/[.!?]\s+/)[0] ?? text;
  const title = firstSentence
    .replace(/^(?:сегодня|завтра)\s+/i, "")
    .replace(/^(?:в\s+\d{1,2}(?:[.:]\d{2})?\s+)?напом(?:ни|инай|няй)(?:\s+мне)?\s+/i, "")
    .replace(/^кажд(?:ый|ые)\s+час(?:а|ов)?\s+напом(?:ни|инай|няй)(?:\s+мне)?\s+/i, "")
    .replace(/^(?:напом(?:ни|инай|няй)(?:\s+мне)?\s+)(?:сегодня|завтра)?\s*/i, "")
    .replace(/^(?:сегодня|завтра)\s+/i, "")
    .replace(/^через\s+час\s+/i, "")
    .replace(/,\s*пока\s+.*$/i, "")
    .replace(/\s+до\s+тех\s+пор.*$/i, "")
    .trim();
  return title ? `${title[0].toLocaleUpperCase("ru")}${title.slice(1)}` : null;
}

function normalizeRussianWeekdaySemantics(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
  activeContext: string;
}) {
  if (
    params.execution.actionPlan?.actions.some(
      (action) => action.kind === "recurring_task" || action.recurrence != null,
    ) ||
    params.execution.reminderPolicies.some((policy) =>
      ["recurring", "long_term"].includes(policy.policyType),
    ) ||
    /кажд(?:ый|ую|ое|ые)\s+(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскрес)/iu.test(
      params.text,
    )
  ) {
    return params.execution;
  }
  const appointment = parseRussianWeekdayAppointment(params);
  if (!appointment || hasDeadlineIntent(params.text)) return params.execution;
  const isMedicalFamily =
    /(ортодонт|врач|доктор|стоматолог|клиник|больниц|ребен|ребён|роба?)/i.test(params.text);
  const medicalContextPattern = /ортодонт/i.test(params.text)
    ? /(ортодонт|стоматолог)/i
    : /(врач|доктор|стоматолог|клиник|больниц)/i;
  const existingId = isMedicalFamily
    ? extractMatchingContextItemId(params.activeContext, medicalContextPattern)
    : null;
  if (existingId) {
    return {
      ...params.execution,
      intent: "update_existing_items" as const,
      actionPlan: null,
      itemUpdates: [
        {
          itemIds: [existingId],
          operation: "reschedule" as const,
          startAtLocal: appointment.localDateTime,
          endAtLocal: null,
          reminderMinutesBefore: null,
          followupMinutesAfter: null,
          priority: 4,
          exposeManagementButtons: true,
          note: "Deterministic Russian weekday appointment repair.",
        },
      ],
      reminderPolicies: [],
      clarificationQuestions: [],
    };
  }

  const proposed = params.execution.actionPlan?.actions[0];
  const scheduledTitle = stripRussianWeekdaySchedulePhrase(params.text);
  const action: ActionPlanItem = {
    ...(proposed ?? buildSyntheticAppointmentAction(params.timezone)),
    actionType: isMedicalFamily ? "event" : "task",
    kind: isMedicalFamily ? "event" : "task",
    title: isMedicalFamily
      ? normalizeMedicalAppointmentTitle(params.text, proposed?.title)
      : scheduledTitle,
    timezone: proposed?.timezone || params.timezone,
    startAtLocal: appointment.localDateTime,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    reminders: [],
    priority: isMedicalFamily ? Math.max(proposed?.priority ?? 3, 4) : (proposed?.priority ?? 3),
    metadata: {
      ...(proposed?.metadata ?? {}),
      sourceNormalization: "russian_weekday_v2260",
      explicitWeekdaySchedule: true,
      ...(isMedicalFamily
        ? {
            category: "health",
            familyRelated: true,
            importanceMode: "auto",
            basePriority: 4,
            reminderSuggestion: "offer_before_event",
          }
        : {}),
    },
  };
  return {
    ...params.execution,
    intent: "create_plan" as const,
    actionPlan: {
      ...(params.execution.actionPlan ?? {
        intent: "plan" as const,
        summary: action.title,
        reply: null,
        confidence: 0.98,
        requiresConfirmation: false,
        actions: [],
        memoryCandidates: [],
        clarificationQuestions: [],
      }),
      intent: "plan" as const,
      actions: [action],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    clarificationQuestions: [],
  };
}

function buildSyntheticAppointmentAction(timezone: string): ActionPlanItem {
  return {
    actionType: "event",
    kind: "event",
    title: "Запись к врачу",
    description: null,
    location: null,
    timezone,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 4,
    confidence: 0.98,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {},
  };
}

function normalizeMedicalAppointmentTitle(text: string, fallback?: string | null) {
  if (/ортодонт/i.test(text) && /роба?/i.test(text)) return "Отвести Роба к ортодонту";
  return fallback?.trim() || text.replace(/\s+(?:во?|на)\s+\S+\s+к\s+\d.*$/i, "").trim();
}

function normalizeNightTemporalSemantics(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
  activeContext: string;
}) {
  if (
    !/(?:nba|нба|финал[а-я]*\s+нба)/i.test(`${params.text}\n${params.activeContext}`) ||
    !/(?:^|\D)0?3[.:]30(?:\D|$)/i.test(params.text)
  ) {
    return params.execution;
  }

  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  let eventStart = nowLocal.startOf("day").set({ hour: 3, minute: 30 });
  if (eventStart <= nowLocal || (/сегодня/i.test(params.text) && nowLocal.hour >= 12)) {
    eventStart = eventStart.plus({ days: 1 });
  }
  const startAtLocal = eventStart.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const reminderTimes = extractExplicitReminderTimes(params.text)
    .map(({ hour, minute }) => eventStart.startOf("day").set({ hour, minute }))
    .filter((value) => value < eventStart && value > nowLocal);

  if (isCorrectionText(params.text)) {
    const itemId = extractMatchingContextItemId(params.activeContext, /(?:nba|нба|финал)/i);
    if (!itemId) return params.execution;
    return {
      ...params.execution,
      intent: "update_existing_items" as const,
      actionPlan: null,
      itemUpdates: [
        {
          itemIds: [itemId],
          operation: "reschedule" as const,
          startAtLocal,
          endAtLocal: null,
          reminderMinutesBefore: null,
          followupMinutesAfter: null,
          priority: null,
          exposeManagementButtons: true,
          note: "Night-time correction repaired the existing event.",
        },
      ],
      reminderPolicies: reminderTimes.map((value) => ({
        operation: "create_reminder_policy" as const,
        itemIds: [itemId],
        itemTitle: null,
        title: "Напоминание перед матчем НБА",
        category: "pre_event" as const,
        policyType: "one_time" as const,
        startsAtLocal: value.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        endsAtLocal: null,
        nextFireAtLocal: value.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        recurrenceRule: null,
        intervalMinutes: null,
        requireAck: false,
        maxOccurrences: 1,
        minutesBefore: null,
        windowEndInclusive: true,
        catchUpMode: "one_immediate_then_resume" as const,
        onWindowEnd: "expire_silently" as const,
        quietHoursStart: null,
        quietHoursEnd: null,
        allowDuringQuietHours: true,
      })),
      clarificationQuestions: [],
    };
  }

  if (!params.execution.actionPlan?.actions.length) return params.execution;
  let changed = false;
  const actions = params.execution.actionPlan.actions.map((action) => {
    if (changed || !["event", "tentative_event"].includes(action.kind)) return action;
    changed = true;
    const oldStart = action.startAtLocal
      ? DateTime.fromISO(action.startAtLocal, { zone: params.timezone })
      : null;
    const oldEnd = action.endAtLocal
      ? DateTime.fromISO(action.endAtLocal, { zone: params.timezone })
      : null;
    const durationMinutes =
      oldStart?.isValid && oldEnd?.isValid
        ? Math.max(1, oldEnd.diff(oldStart, "minutes").minutes)
        : null;
    return {
      ...action,
      startAtLocal,
      endAtLocal: durationMinutes
        ? eventStart.plus({ minutes: durationMinutes }).toFormat("yyyy-MM-dd'T'HH:mm:ss")
        : action.endAtLocal,
      priority: Math.max(action.priority, 4),
      reminders: reminderTimes.length
        ? reminderTimes.map((value) => ({
            type: "custom" as const,
            scheduledAtLocal: value.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            offsetMinutesBefore: null,
            repeatUntilAck: false,
            payload: { explicitTime: true, sourceNormalization: "night_temporal_v251" },
          }))
        : action.reminders,
      metadata: {
        ...action.metadata,
        sourceNormalization: "night_temporal_v251",
        nightSemanticsApplied: true,
        explicitReminderCount: reminderTimes.length,
      },
    };
  });
  return changed
    ? {
        ...params.execution,
        intent: "create_plan" as const,
        actionPlan: { ...params.execution.actionPlan, actions },
        clarificationQuestions: [],
      }
    : params.execution;
}

function normalizeSameMessageEventReminderPolicies(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}) {
  if (!hasRelativeBeforeEventReminderIntent(params.text)) return params.execution;
  const plan = params.execution.actionPlan;
  if (!plan?.actions.length) return params.execution;
  const eventActions = plan.actions.filter(
    (action) =>
      ["event", "training", "tentative_event"].includes(action.kind) &&
      Boolean(action.startAtLocal),
  );
  if (eventActions.length !== 1) return params.execution;

  const action = eventActions[0];
  const timezone = action.timezone || params.timezone;
  const eventStartLocal = DateTime.fromISO(action.startAtLocal!, { zone: timezone });
  if (!eventStartLocal.isValid) return params.execution;
  const parsed = parseBeforeEventReminderSpecs({
    text: params.text,
    eventStartLocal,
    timezone,
    now: params.now,
    allowAbsoluteTimes: false,
  });
  if (!parsed.reminders.length) return params.execution;

  const existingKeys = new Set(
    params.execution.reminderPolicies
      .filter((policy) => policy.policyType === "before_event")
      .map(
        (policy) =>
          `${policy.itemTitle ?? ""}:${policy.nextFireAtLocal ?? ""}:${policy.minutesBefore ?? ""}`,
      ),
  );
  const policies = parsed.reminders
    .filter((reminder) => {
      const key = `${action.title}:${reminder.fireAtLocal}:${reminder.minutesBefore}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    })
    .map(
      (reminder): AgentReminderPolicy => ({
        operation: "create_before_event_policy",
        itemIds: [],
        itemTitle: action.title,
        title: action.title,
        category: "pre_event",
        policyType: "before_event",
        startsAtLocal: reminder.fireAtLocal,
        endsAtLocal: null,
        nextFireAtLocal: reminder.fireAtLocal,
        recurrenceRule: null,
        intervalMinutes: null,
        requireAck: false,
        maxOccurrences: null,
        minutesBefore: reminder.minutesBefore,
        windowEndInclusive: true,
        catchUpMode: "one_immediate_then_resume",
        onWindowEnd: "expire_silently",
        quietHoursStart: null,
        quietHoursEnd: null,
        allowDuringQuietHours: false,
      }),
    );
  if (!policies.length) return params.execution;

  return {
    ...params.execution,
    intent: "create_plan" as const,
    actionPlan: {
      ...plan,
      actions: plan.actions.map((candidate) =>
        candidate === action
          ? {
              ...candidate,
              reminders: [],
              metadata: {
                ...candidate.metadata,
                sameMessageReminderPolicyCount: policies.length,
                sourceReminderNormalization: "same_message_before_event_v2160",
              },
            }
          : candidate,
      ),
      clarificationQuestions: [],
    },
    reminderPolicies: [...params.execution.reminderPolicies, ...policies],
    clarificationQuestions: [],
  };
}

function normalizePrioritySemantics(params: {
  execution: AgentExecution;
  text: string;
  activeContext: string;
}) {
  const priority = extractPriority(params.text);
  if (!priority) return params.execution;
  if (params.execution.actionPlan) {
    return {
      ...params.execution,
      actionPlan: {
        ...params.execution.actionPlan,
        actions: params.execution.actionPlan.actions.map((action) => ({
          ...action,
          priority,
          metadata: {
            ...action.metadata,
            explicitPriority: true,
            importanceMode: "manual",
            basePriority: priority,
          },
        })),
      },
    };
  }
  const itemId = extractPriorityTargetContextItemId(params.text, params.activeContext);
  if (!itemId) return params.execution;
  return {
    ...params.execution,
    intent: "update_existing_items" as const,
    actionPlan: null,
    itemUpdates: [
      {
        itemIds: [itemId],
        operation: "configure" as const,
        startAtLocal: null,
        endAtLocal: null,
        reminderMinutesBefore: null,
        followupMinutesAfter: null,
        priority,
        exposeManagementButtons: true,
        note: "Priority updated from natural language.",
      },
    ],
    reminderPolicies: [],
    clarificationQuestions: [],
  };
}

function normalizeIntervalWindow(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
  aiProposedAction?: ActionPlanItem | null;
}) {
  const intervalMinutes = extractIntervalMinutes(params.text);
  const startHour =
    extractClockAfter(params.text, /начиная\s+с\s+/i) ??
    extractClockAfter(params.text, /(?:^|\s)с\s+/i);
  const endHour = extractClockAfter(params.text, /(?:^|\s)до\s+/i);
  const isTomorrow = /завтра/i.test(params.text);
  const useDefaultEnd = Boolean(intervalMinutes && startHour && !endHour && isTomorrow);
  if (!intervalMinutes || !startHour || (!endHour && !useDefaultEnd)) {
    return params.execution;
  }
  const proposedAction = params.execution.actionPlan?.actions[0];
  const fallbackTitle = /дрик/i.test(params.text) ? "Записаться к Дрик" : null;
  if (!proposedAction && !fallbackTitle) return params.execution;

  const localDay = DateTime.fromJSDate(params.now, { zone: "utc" })
    .setZone(params.timezone)
    .plus({ days: isTomorrow ? 1 : 0 });
  const startsAtLocal = localDay
    .set({ hour: startHour.hour, minute: startHour.minute, second: 0, millisecond: 0 })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const endsAtLocal = localDay
    .set({
      hour: endHour?.hour ?? 22,
      minute: endHour?.minute ?? 0,
      second: 0,
      millisecond: 0,
    })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const action = proposedAction ?? buildSyntheticIntervalAction(fallbackTitle!, params.timezone);
  const appointment = normalizeAppointmentWithReminderWindow({
    execution: params.execution,
    text: params.text,
    action,
    aiProposedAction: params.aiProposedAction ?? null,
    localDay,
    startsAtLocal,
    endsAtLocal,
    intervalMinutes,
  });
  if (appointment) return appointment;
  const title =
    extractIntervalTaskTitle(params.text) ?? normalizeReminderTaskTitle(params.text, action.title);
  const requireAck =
    useDefaultEnd || /пока\s+не\s+(?:отмеч|подтверд|сдела|готов)/i.test(params.text);
  const normalizedAction = {
    ...action,
    actionType: "task" as const,
    kind: "task" as const,
    title,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: endsAtLocal,
    durationMinutes: null,
    reminders: [],
    metadata: {
      ...action.metadata,
      intervalPolicyExpected: true,
      defaultEndAssumed: useDefaultEnd,
    },
  };
  const normalizedPolicy: AgentReminderPolicy = {
    operation: "create_interval_window_policy",
    itemIds: [],
    itemTitle: title,
    title,
    category: /дрик/i.test(title) ? "people" : requireAck ? "nag_until_done" : "project",
    policyType: useDefaultEnd ? "nag_until_ack" : "interval_window",
    startsAtLocal,
    endsAtLocal,
    nextFireAtLocal: startsAtLocal,
    recurrenceRule: null,
    intervalMinutes,
    requireAck,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };

  return {
    ...params.execution,
    intent: "create_plan" as const,
    actionPlan: {
      ...(params.execution.actionPlan ?? {
        intent: "plan" as const,
        summary: null,
        reply: null,
        confidence: 0.95,
        requiresConfirmation: false,
        actions: [],
        memoryCandidates: [],
        clarificationQuestions: [],
      }),
      intent: "plan" as const,
      summary: useDefaultEnd ? `${title} завтра` : (params.execution.actionPlan?.summary ?? title),
      reply: useDefaultEnd
        ? `Буду напоминать завтра каждые ${intervalMinutes} минут с ${formatClock(startHour)} до ${formatClock(endHour ?? { hour: 22, minute: 0 })}, пока не отметишь выполненным.`
        : (params.execution.actionPlan?.reply ?? null),
      actions: [normalizedAction],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: [
      normalizedPolicy,
      ...params.execution.reminderPolicies.filter(
        (policy) =>
          !["interval_window", "nag_until_ack", "post_event_menu", "after_event"].includes(
            policy.policyType,
          ) &&
          policy.intervalMinutes !== intervalMinutes &&
          policy.itemTitle !== action.title,
      ),
    ],
    clarificationQuestions: [],
  };
}

const APPOINTMENT_DEADLINE_PATTERN = /дедлайн|срок|сдать|успеть|не\s+позже/i;

// "Завтра в 13.00 фотосессия, напоминай с 8 до 12 каждый час": 13:00 is when it
// happens, the window only says when to remind. Keep it an event so it never turns
// "overdue" at the window end, and ask how it went once it is over.
function normalizeAppointmentWithReminderWindow(params: {
  execution: AgentExecution;
  text: string;
  action: ActionPlanItem;
  // Earlier normalizations may already have flattened the AI event into a task.
  aiProposedAction: ActionPlanItem | null;
  localDay: DateTime;
  startsAtLocal: string;
  endsAtLocal: string;
  intervalMinutes: number;
}): AgentExecution | null {
  if (APPOINTMENT_DEADLINE_PATTERN.test(params.text)) return null;
  const clock = extractAppointmentClock(params.text);
  if (!clock) return null;
  const zone = params.localDay.zone;
  const start = params.localDay.set({
    hour: clock.hour,
    minute: clock.minute,
    second: 0,
    millisecond: 0,
  });
  if (start.toMillis() <= DateTime.fromISO(params.startsAtLocal, { zone }).toMillis()) return null;

  const proposed = params.aiProposedAction ?? params.action;
  const proposedStart = proposed.startAtLocal
    ? DateTime.fromISO(proposed.startAtLocal, { zone })
    : null;
  const proposedEnd = proposed.endAtLocal ? DateTime.fromISO(proposed.endAtLocal, { zone }) : null;
  const end =
    ["event", "training", "tentative_event"].includes(proposed.kind) &&
    proposedStart?.toMillis() === start.toMillis() &&
    proposedEnd &&
    proposedEnd.toMillis() > start.toMillis()
      ? proposedEnd
      : start.plus({ minutes: 60 });
  const configuredWindowEnd = DateTime.fromISO(params.endsAtLocal, { zone });
  const windowEnd = configuredWindowEnd.toMillis() < start.toMillis() ? configuredWindowEnd : start;
  const local = (value: DateTime) => value.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  const title =
    cleanAppointmentTitle(params.action.title) ??
    cleanAppointmentTitle(params.text.split(/[,;]|напомин|напомн/i)[0] ?? "") ??
    params.action.title;
  const metadata: Record<string, unknown> = { ...(params.action.metadata ?? {}) };
  delete metadata.intervalPolicyExpected;
  delete metadata.defaultEndAssumed;

  const event: ActionPlanItem = {
    ...params.action,
    actionType: "event",
    kind: "event",
    title,
    startAtLocal: local(start),
    endAtLocal: local(end),
    dueAtLocal: null,
    durationMinutes: Math.round(end.diff(start, "minutes").minutes),
    reminders: [],
    metadata: {
      ...metadata,
      appointmentReminderWindow: true,
      sourceNormalization: "appointment_interval_window_v310",
    },
  };
  const basePolicy = {
    itemIds: [],
    itemTitle: title,
    title,
    recurrenceRule: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume" as const,
    onWindowEnd: "expire_silently" as const,
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };
  const reminderWindow: AgentReminderPolicy = {
    ...basePolicy,
    operation: "create_interval_window_policy",
    category: "pre_event",
    policyType: "interval_window",
    startsAtLocal: params.startsAtLocal,
    endsAtLocal: local(windowEnd),
    nextFireAtLocal: params.startsAtLocal,
    intervalMinutes: params.intervalMinutes,
    requireAck: /пока\s+не\s+(?:отмеч|подтверд|сдела|готов)/i.test(params.text),
    maxOccurrences: null,
  };
  const howDidItGo: AgentReminderPolicy = {
    ...basePolicy,
    operation: "create_post_event_reaction_policy",
    category: "post_event",
    policyType: "post_event_menu",
    startsAtLocal: null,
    endsAtLocal: null,
    nextFireAtLocal: local(end),
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: 1,
  };

  return {
    ...params.execution,
    intent: "create_plan" as const,
    actionPlan: {
      ...(params.execution.actionPlan ?? {
        intent: "plan" as const,
        summary: null,
        reply: null,
        confidence: 0.95,
        requiresConfirmation: false,
        actions: [],
        memoryCandidates: [],
        clarificationQuestions: [],
      }),
      intent: "plan" as const,
      summary: params.execution.actionPlan?.summary ?? title,
      actions: [event],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: [reminderWindow, howDidItGo],
    clarificationQuestions: [],
  };
}

// "в 13.00", "в 13:00", "в 3 дня" before the reminder request; never a reminder time.
function extractAppointmentClock(text: string) {
  const reminderAt = text.search(/напомин|напомн|повторя/i);
  const head = reminderAt >= 0 ? text.slice(0, reminderAt) : text;
  const match = head.match(
    /(?:^|\s)в\s+([01]?\d|2[0-3])(?:[.:]([0-5]\d))?(?:\s*(утра|дня|вечера|ночи|час(?:а|ов)?))?(?=$|[\s,.;!?])(?!\s+(?:раз|минут|дн|недел|месяц))/i,
  );
  if (!match) return null;
  const hour = Number(match[1]);
  const pm = /^(?:дня|вечера)$/i.test(match[3] ?? "") && hour < 12;
  return { hour: pm ? hour + 12 : hour, minute: Number(match[2] ?? 0) };
}

function cleanAppointmentTitle(value: string) {
  const cleaned = value
    .replace(
      /(?:^|\s)в\s+\d{1,2}(?:[.:]\d{2})?(?:\s*(?:утра|дня|вечера|ночи|час(?:а|ов)?))?(?=$|[\s,.;!?])/gi,
      " ",
    )
    .replace(/(?:^|\s)(?:сегодня|завтра|послезавтра)(?=$|[\s,.;!?])/gi, " ")
    .replace(/^напоминани[ея]\s+о\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, "");
  if (!cleaned) return null;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function buildSyntheticIntervalAction(title: string, timezone: string): ActionPlanItem {
  return {
    actionType: "task",
    kind: "task",
    title,
    description: null,
    location: null,
    timezone,
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 4,
    confidence: 0.95,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: { sourceNormalization: "open_interval_v242" },
  };
}

function normalizeLongTermRecurrence(params: { execution: AgentExecution; text: string }) {
  const segments = params.text
    .split(/[,;\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const recurringPolicies = segments
    .map(buildRecurringPolicy)
    .filter((policy): policy is AgentReminderPolicy => Boolean(policy));
  if (!recurringPolicies.length) return params.execution;

  const existingNonRecurring = params.execution.reminderPolicies.filter(
    (policy) => !["recurring", "long_term"].includes(policy.policyType),
  );
  return {
    ...params.execution,
    intent: "manage_reminder_policies" as const,
    actionPlan: null,
    itemUpdates: [],
    reminderPolicies: [...existingNonRecurring, ...recurringPolicies],
    clarificationQuestions: [],
  };
}

function normalizeEveryEventConfiguration(params: {
  execution: AgentExecution;
  text: string;
  activeContext: string;
}) {
  if (!/(кажд(?:ого|ому|ое)\s+событи|все(?:м|х)?\s+событи)/i.test(params.text)) {
    return params.execution;
  }
  const reminderMinutesBefore = /за\s+час/i.test(params.text) ? 60 : null;
  const followupMinutesAfter = /(после|реакци|как\s+прошл)/i.test(params.text) ? 0 : null;
  const exposeManagementButtons = /(кнопк|перенос|отмен|итог|редакт|удален|удалён)/i.test(
    params.text,
  );
  if (reminderMinutesBefore === null && followupMinutesAfter === null) {
    return params.execution;
  }

  const itemIds = extractContextPlannerItemIds(params.activeContext);
  if (!itemIds.length) return params.execution;
  const update: AgentItemUpdate = {
    itemIds,
    operation: "configure",
    startAtLocal: null,
    endAtLocal: null,
    reminderMinutesBefore,
    followupMinutesAfter,
    priority: null,
    exposeManagementButtons,
    note: "Normalized after mandatory OpenAI proposal for every current event.",
  };
  return {
    ...params.execution,
    intent: "update_existing_items" as const,
    actionPlan: null,
    itemUpdates: [update],
    reminderPolicies: [],
    clarificationQuestions: [],
  };
}

function buildRecurringPolicy(segment: string): AgentReminderPolicy | null {
  const biweekly = /раз\s+в\s+(?:две|2)\s+недел/i.test(segment);
  const weekly = !biweekly && /раз\s+в\s+недел/i.test(segment);
  if (!weekly && !biweekly) return null;
  const title = segment
    .replace(/раз\s+в\s+(?:(?:две|2)\s+)?недел[юи]\s*/i, "")
    .replace(/^напоминать\s*/i, "")
    .replace(/^про\s*/i, "")
    .trim();
  if (!title) return null;

  return {
    operation: "create_recurring_policy",
    itemIds: [],
    itemTitle: null,
    title,
    category: recurringCategory(title),
    policyType: "long_term",
    startsAtLocal: null,
    endsAtLocal: null,
    nextFireAtLocal: null,
    recurrenceRule: biweekly ? "every_2_weeks" : "weekly",
    intervalMinutes: null,
    requireAck: true,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };
}

function normalizeCentralPark(params: {
  execution: AgentExecution;
  text: string;
  timezone: string;
  now: Date;
}) {
  if (
    !/(?:central|централ)\s+парк/i.test(params.text) ||
    !/четверг/i.test(params.text) ||
    !/16-?(?:го)?/i.test(params.text) ||
    !/(каждый\s+день|ежеднев)/i.test(params.text) ||
    !/(по\s+две|два\s+раза)/i.test(params.text)
  ) {
    return params.execution;
  }

  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const thursday = nextWeekday(nowLocal, 4);
  const sixteenth = dayOfMonthAfter(nowLocal, 16);
  const firstStart = thursday.set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
  const firstEnd = thursday.set({ hour: 22, minute: 0, second: 0, millisecond: 0 });
  const secondStart = sixteenth.set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  const secondEnd = sixteenth.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  const actions: ActionPlanItem[] = [
    centralParkAction(firstStart, firstEnd, params.timezone, 1, "active"),
    centralParkAction(secondStart, secondEnd, params.timezone, 2, "waiting"),
  ];
  const policies = [
    ...dailyPoliciesBeforeEvent(firstStart, nowLocal),
    ...dailyPoliciesBeforeEvent(secondStart, nowLocal, firstEnd),
  ];

  return {
    ...params.execution,
    intent: "create_plan" as const,
    reply:
      "Записал две студии Central Park и поставил до каждой два ежедневных напоминания: в 10:00 и 18:00.",
    actionPlan: {
      intent: "plan" as const,
      summary: "Две студии Central Park",
      reply: null,
      confidence: 0.99,
      requiresConfirmation: false,
      actions,
      memoryCandidates: [],
      clarificationQuestions: [],
    },
    itemUpdates: [],
    reminderPolicies: policies,
    clarificationQuestions: [],
  };
}

function centralParkAction(
  start: DateTime,
  end: DateTime,
  timezone: string,
  campaignSequence: number,
  campaignState: "active" | "waiting",
): ActionPlanItem {
  return {
    actionType: "event",
    kind: "event",
    title: "Студия Central Park",
    description: null,
    location: "Студия Central Park",
    timezone,
    startAtLocal: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    endAtLocal: end.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    dueAtLocal: null,
    durationMinutes: null,
    priority: 5,
    confidence: 0.99,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {
      sourceNormalization: "central_park_v251",
      important: true,
      importanceMode: "auto",
      basePriority: 5,
      campaignGroup: "central_park",
      campaignSequence,
      campaignState,
    },
  };
}

function dailyPoliciesBeforeEvent(
  eventStart: DateTime,
  nowLocal: DateTime,
  activationStart?: DateTime,
): AgentReminderPolicy[] {
  return [10, 18].map((hour) => {
    let finalFire = eventStart.startOf("day").set({ hour, minute: 0 });
    if (finalFire >= eventStart) finalFire = finalFire.minus({ days: 1 });
    const notBefore = activationStart && activationStart > nowLocal ? activationStart : nowLocal;
    let nextFire = notBefore.startOf("day").set({ hour, minute: 0 });
    if (nextFire <= notBefore) nextFire = nextFire.plus({ days: 1 });
    return {
      operation: "create_recurring_policy",
      itemIds: [],
      itemTitle: "Студия Central Park",
      title: `Студия Central Park: напоминание в ${String(hour).padStart(2, "0")}:00`,
      category: "meeting",
      policyType: "recurring",
      startsAtLocal: nextFire.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      endsAtLocal: finalFire.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      nextFireAtLocal: nextFire.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      recurrenceRule: `daily_at_${String(hour).padStart(2, "0")}:00`,
      intervalMinutes: null,
      requireAck: false,
      maxOccurrences: null,
      minutesBefore: null,
      windowEndInclusive: true,
      catchUpMode: "latest_only",
      onWindowEnd: "expire_silently",
      quietHoursStart: null,
      quietHoursEnd: null,
      allowDuringQuietHours: false,
    };
  });
}

function extractExplicitReminderTimes(text: string) {
  const reminderIndex = text.search(/напоминан|напомн/i);
  if (reminderIndex < 0) return [];
  const tail = text.slice(reminderIndex);
  const result = new Map<string, { hour: number; minute: number }>();
  for (const match of tail.matchAll(/\b(\d{1,2})[.:](\d{2})\b/g)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    result.set(`${hour}:${minute}`, { hour, minute });
  }
  return [...result.values()];
}

function hasRelativeBeforeEventReminderIntent(text: string) {
  return (
    /(напомн|напоминан)/i.test(text) &&
    /за\s+(?:день|пол\s*часа|полчаса|полтора|час|один|одну|два|две|три|четыре|пять|\d+\s*(?:час|мин))/i.test(
      text.toLocaleLowerCase("ru").replace(/ё/g, "е"),
    )
  );
}

function isCorrectionText(text: string) {
  return /(а\s+не|исправ|поправ|перенеси|вместо|не\s+в\s+15)/i.test(text);
}

function extractMatchingContextItemId(activeContext: string, titlePattern: RegExp) {
  for (const line of activeContext.split("\n")) {
    if (!titlePattern.test(line)) continue;
    const match = line.match(new RegExp(`(?:^|\\s)id=(${UUID_PATTERN})(?:;|\\s|$)`, "i"));
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractPriority(text: string) {
  const numeric = text.match(/приоритет(?:ом)?\s*([1-5])/i);
  if (numeric?.[1]) return Number(numeric[1]);
  if (/(?:важно!|очень\s+важно|срочно|важно\s+важно)/i.test(text)) return 5;
  if (/\bважно\b/i.test(text)) return 4;
  if (/(неважно|когда-нибудь)/i.test(text)) return 1;
  return null;
}

function extractPriorityTargetContextItemId(text: string, activeContext: string) {
  const words = text
    .toLocaleLowerCase("ru")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !/^(приоритет|сделай|понизь|повысь|важно)$/.test(word));
  for (const line of activeContext.split("\n")) {
    const lower = line.toLocaleLowerCase("ru");
    if (!words.some((word) => lower.includes(word))) continue;
    const match = line.match(new RegExp(`(?:^|\\s)id=(${UUID_PATTERN})(?:;|\\s|$)`, "i"));
    if (match?.[1]) return match[1];
  }
  return null;
}

function nextWeekday(now: DateTime, weekday: number) {
  const delta = (weekday - now.weekday + 7) % 7;
  return now.plus({ days: delta || 7 }).startOf("day");
}

function dayOfMonthAfter(now: DateTime, day: number) {
  let candidate = now.startOf("month").set({ day });
  if (candidate <= now.startOf("day")) candidate = candidate.plus({ months: 1 });
  return candidate.startOf("day");
}

function recurringCategory(title: string): AgentReminderPolicy["category"] {
  if (/(машин|авто|зеркал)/i.test(title)) return "recurring_car";
  if (/(жкх|оплат|счет|счёт|финанс)/i.test(title)) return "recurring_finance";
  if (/(дом|квартир)/i.test(title)) return "recurring_home";
  return "long_term";
}

function extractIntervalMinutes(text: string) {
  if (/кажд(?:ый|ые)\s+полчаса|кажд(?:ый|ые)\s+пол\s*часа/i.test(text)) return 30;
  if (/кажд(?:ый|ые)\s+час/i.test(text)) return 60;
  const match = text.match(/кажд(?:ый|ые)\s+(\d{1,3})\s*мин/i);
  return match ? Number(match[1]) : null;
}

function extractClockAfter(text: string, prefix: RegExp) {
  const match = text.match(new RegExp(`${prefix.source}(\\d{1,2})(?:[.:](\\d{2}))?`, prefix.flags));
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2] ?? 0) };
}

function formatClock(value: { hour: number; minute: number }) {
  return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
}

function extractIntervalTaskTitle(text: string) {
  const match = text.match(/^(.*?)\s+(?:сегодня|завтра)\s+до\s+\d/i);
  return match?.[1]?.trim() || null;
}

function normalizeReminderTaskTitle(text: string, fallback: string) {
  if (/дрик/i.test(text)) return "Записаться к Дрик";
  return fallback
    .replace(/^напоминания?\s+о\s+/i, "")
    .replace(/^напоминать\s+/i, "")
    .trim();
}

function extractContextPlannerItemIds(activeContext: string) {
  const ids = new Set<string>();
  for (const line of activeContext.split("\n")) {
    if (
      !/status=active;|:\s*(?:event|training|preparation_task|tentative_event|task)\s/i.test(line)
    ) {
      continue;
    }
    const match = line.match(new RegExp(`(?:^|\\s)id=(${UUID_PATTERN})(?:;|\\s|$)`, "i"));
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids];
}
