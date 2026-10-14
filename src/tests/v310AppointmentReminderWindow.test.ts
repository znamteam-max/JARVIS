import { describe, expect, it } from "vitest";

import { normalizeAgentExecutionProposal } from "@/ai/agentExecutionNormalization";
import {
  validatePlannerItemsBeforeSave,
  validateReminderPoliciesBeforeSave,
} from "@/ai/antiGarbageValidator";
import { agentExecutionSchema, type AgentReminderPolicy } from "@/ai/schemas/agentExecution";

// Production message of 2026-10-13 22:10 MSK.
const now = new Date("2026-10-13T19:10:19.009Z");
const photoText = "Завтра в 13.00 фотосессия, напоминай с 8 утра до 12 каждый час";

describe("V3.1.0 appointment time with an hourly reminder window", () => {
  it("keeps 'в 13.00 фотосессия' an event and asks how it went after it ends", () => {
    const execution = normalize(photoText, [
      action({
        actionType: "task",
        kind: "task",
        title: "В 13.00 фотосессия",
        dueAtLocal: "2026-10-14T12:00:00",
      }),
    ]);

    expect(execution.actionPlan?.actions).toHaveLength(1);
    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        actionType: "event",
        kind: "event",
        title: "Фотосессия",
        startAtLocal: "2026-10-14T13:00:00",
        endAtLocal: "2026-10-14T14:00:00",
        dueAtLocal: null,
      }),
    );
    expect(execution.actionPlan?.actions[0].metadata?.intervalPolicyExpected).toBeUndefined();
    expect(execution.reminderPolicies).toEqual([
      expect.objectContaining({
        operation: "create_interval_window_policy",
        policyType: "interval_window",
        itemTitle: "Фотосессия",
        startsAtLocal: "2026-10-14T08:00:00",
        endsAtLocal: "2026-10-14T12:00:00",
        intervalMinutes: 60,
        requireAck: false,
      }),
      expect.objectContaining({
        operation: "create_post_event_reaction_policy",
        policyType: "post_event_menu",
        category: "post_event",
        itemTitle: "Фотосессия",
        nextFireAtLocal: "2026-10-14T14:00:00",
      }),
    ]);
    expectSavable(execution, photoText);
  });

  it("keeps the AI event duration when it proposed one", () => {
    const execution = normalize(photoText, [
      action({
        actionType: "event",
        kind: "event",
        title: "Фотосессия",
        startAtLocal: "2026-10-14T13:00:00",
        endAtLocal: "2026-10-14T15:00:00",
      }),
    ]);

    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({
        kind: "event",
        startAtLocal: "2026-10-14T13:00:00",
        endAtLocal: "2026-10-14T15:00:00",
      }),
    );
    expect(execution.reminderPolicies[1]).toEqual(
      expect.objectContaining({
        policyType: "post_event_menu",
        nextFireAtLocal: "2026-10-14T15:00:00",
      }),
    );
  });

  it("stops the reminder window at the event start", () => {
    const text = "Завтра в 10.30 встреча с юристом, напоминай с 8 до 12 каждые полчаса";
    const execution = normalize(text, [
      action({ actionType: "task", kind: "task", title: "Встреча с юристом" }),
    ]);

    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({ kind: "event", startAtLocal: "2026-10-14T10:30:00" }),
    );
    expect(execution.reminderPolicies[0]).toEqual(
      expect.objectContaining({
        startsAtLocal: "2026-10-14T08:00:00",
        endsAtLocal: "2026-10-14T10:30:00",
        intervalMinutes: 30,
      }),
    );
    expectSavable(execution, text);
  });

  it("leaves deadline wording as a task", () => {
    const text = "Завтра дедлайн в 13.00 сдать макет, напоминай с 8 до 12 каждый час";
    const execution = normalize(text, [
      action({ actionType: "task", kind: "task", title: "Сдать макет" }),
    ]);

    expect(execution.actionPlan?.actions[0]).toEqual(
      expect.objectContaining({ kind: "task", startAtLocal: null }),
    );
    expect(execution.reminderPolicies.map((policy) => policy.policyType)).toEqual([
      "interval_window",
    ]);
  });
});

function normalize(text: string, actions: ReturnType<typeof action>[]) {
  return normalizeAgentExecutionProposal({
    execution: agentExecutionSchema.parse({
      intent: "create_plan",
      reply: null,
      actionPlan: {
        intent: "plan",
        summary: null,
        reply: null,
        confidence: 0.9,
        requiresConfirmation: false,
        actions,
        memoryCandidates: [],
        clarificationQuestions: [],
      },
      viewScope: null,
      resetMode: null,
      itemUpdates: [],
      reminderPolicies: [
        policy({
          operation: "create_interval_window_policy",
          policyType: "interval_window",
          title: actions[0].title,
          itemTitle: actions[0].title,
          startsAtLocal: "2026-10-14T08:00:00",
          endsAtLocal: "2026-10-14T12:00:00",
          intervalMinutes: 60,
        }),
      ],
      memoryFacts: [],
      clarificationQuestions: [],
    }),
    text,
    timezone: "Europe/Moscow",
    now,
    activeContext: "none",
  });
}

function expectSavable(
  execution: ReturnType<typeof normalizeAgentExecutionProposal>,
  originalMessage: string,
) {
  expect(validatePlannerItemsBeforeSave({ plan: execution.actionPlan!, originalMessage })).toEqual({
    ok: true,
    warnings: [],
  });
  expect(
    validateReminderPoliciesBeforeSave({
      plan: execution.actionPlan!,
      policies: execution.reminderPolicies,
      timezone: "Europe/Moscow",
      originalMessage,
    }),
  ).toEqual({ ok: true, warnings: [] });
}

function action(overrides: {
  actionType: "task" | "event";
  kind: "task" | "event";
  title: string;
  startAtLocal?: string | null;
  endAtLocal?: string | null;
  dueAtLocal?: string | null;
}) {
  return {
    description: null,
    location: null,
    timezone: "Europe/Moscow",
    startAtLocal: null,
    endAtLocal: null,
    dueAtLocal: null,
    durationMinutes: null,
    priority: 3,
    confidence: 0.9,
    risk: "low",
    requiresConfirmation: false,
    tentative: false,
    recurrence: null,
    reminders: [],
    memoryCandidates: [],
    metadata: {},
    ...overrides,
  };
}

function policy(overrides: Partial<AgentReminderPolicy> = {}): AgentReminderPolicy {
  return {
    operation: "create_recurring_policy",
    itemIds: [],
    itemTitle: null,
    title: "Напоминание",
    category: "project",
    policyType: "interval_window",
    startsAtLocal: null,
    endsAtLocal: null,
    nextFireAtLocal: null,
    recurrenceRule: null,
    intervalMinutes: null,
    requireAck: false,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "expire_silently",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
    ...overrides,
  };
}
