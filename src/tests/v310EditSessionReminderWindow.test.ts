import { describe, expect, it } from "vitest";

import { isSessionFollowUpScheduleText } from "@/bot/sessionRouting";
import type { PlannerItem } from "@/db/schema";
import { parseItemEditMutation } from "@/services/itemEditMutations";

// Production 2026-10-14 23:39 MSK: the bot asked for a new time for the NBA task and the
// reply was turned into a new task titled "С 6 утра до 9 утра" instead.
const reply = "Завтра с 6 утра до 9 утра, каждый час напоминай, дедлайн 10 утра";
const now = new Date("2026-10-14T20:39:20.000Z");

describe("V3.1.0 edit-session replies with a reminder window", () => {
  it("treats a bare time/reminder reply as an answer to the open edit session", () => {
    expect(isSessionFollowUpScheduleText(reply)).toBe(true);
    expect(isSessionFollowUpScheduleText("на понедельник в 8 утра")).toBe(true);
    expect(isSessionFollowUpScheduleText("Купить молоко завтра в 10, напоминай каждый час")).toBe(
      false,
    );
    expect(isSessionFollowUpScheduleText("Каждый час напоминай про отчёт")).toBe(false);
  });

  it("moves the deadline and turns the range into hourly reminders, not a time slot", () => {
    const mutation = parseItemEditMutation({
      text: reply,
      item: nbaTask(),
      timezone: "Europe/Moscow",
      now,
    });

    expect(mutation.deadlineAtLocal).toBe("2026-10-15T10:00:00+03:00");
    expect(mutation.scheduledForLocal).toBeUndefined();
    expect(mutation.endsAtLocal).toBeUndefined();
    expect(mutation.kind).toBeUndefined();
    expect(mutation.reminderPolicy).toEqual({
      policyType: "nag_until_ack",
      startsAtLocal: "2026-10-15T06:00:00+03:00",
      endsAtLocal: "2026-10-15T09:00:00+03:00",
      intervalMinutes: 60,
      activeWindowStart: "06:00",
      activeWindowEnd: "09:00",
      stopCondition: "until_done",
    });
    expect(mutation.changedFields).toEqual(["deadline", "reminder_policy"]);
  });
});

function nbaTask(): PlannerItem {
  return {
    id: "173b65da-21ba-4ade-8838-700dfd89e670",
    kind: "task",
    title: "Посмотреть верстку на НБА, дедлайн 23.59",
    startAt: null,
    endAt: null,
    dueAt: new Date("2026-10-14T20:59:00.000Z"),
    timezone: "Europe/Moscow",
    metadata: {},
  } as unknown as PlannerItem;
}
