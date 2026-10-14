import { describe, expect, it } from "vitest";

import type { AgentReminderPolicy } from "@/ai/schemas/agentExecution";
import type { plannerItems } from "@/db/schema";
import { matchPolicyTargetsByTitle } from "@/services/actionPlanCommit";

type PlannerItemRow = typeof plannerItems.$inferSelect;

describe("V3.1.0 reminder policy target matching", () => {
  it("attaches a differently worded policy to the only created item", () => {
    // Production 2026-10-14: the policy kept "сегодня", the task did not, and the
    // unattached policy sent bare "Напоминание." cards.
    const task = item("Посмотреть верстку на НБА, дедлайн 23.59");
    const targets = matchPolicyTargetsByTitle({
      proposal: proposal("Посмотреть верстку на НБА, дедлайн 23.59 сегодня"),
      createdItems: [task],
      timezone: "Europe/Moscow",
    });

    expect(targets).toEqual([task]);
  });

  it("does not guess between several created items", () => {
    const targets = matchPolicyTargetsByTitle({
      proposal: proposal("Позвонить юристу сегодня"),
      createdItems: [item("Позвонить юристу"), item("Отправить договор")],
      timezone: "Europe/Moscow",
    });

    expect(targets).toEqual([]);
  });

  it("keeps a policy without a target title unattached", () => {
    const targets = matchPolicyTargetsByTitle({
      proposal: proposal(null),
      createdItems: [item("Позвонить юристу")],
      timezone: "Europe/Moscow",
    });

    expect(targets).toEqual([]);
  });
});

function item(title: string): PlannerItemRow {
  return { id: `item-${title}`, title, startAt: null } as unknown as PlannerItemRow;
}

function proposal(itemTitle: string | null): AgentReminderPolicy {
  return {
    operation: "create_interval_window_policy",
    itemIds: [],
    itemTitle,
    title: itemTitle ?? "Напоминание",
    category: "nag_until_done",
    policyType: "nag_until_ack",
    startsAtLocal: "2026-10-14T19:30:00",
    endsAtLocal: null,
    nextFireAtLocal: null,
    recurrenceRule: null,
    intervalMinutes: 60,
    requireAck: true,
    maxOccurrences: null,
    minutesBefore: null,
    windowEndInclusive: true,
    catchUpMode: "one_immediate_then_resume",
    onWindowEnd: "carry_to_next_day",
    quietHoursStart: null,
    quietHoursEnd: null,
    allowDuringQuietHours: false,
  };
}
