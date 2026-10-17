import { describe, expect, it } from "vitest";

import { chatModelLabel } from "@/domain/chatModelLabel";
import { groupTrainingSessions, recentLoadBlock } from "@/domain/recentLoad";
import { conversationTranscript } from "@/services/coach";
import { formatCoachChatExport } from "@/services/coachExport";
import { composeJarvisAnswer, failureLine, parseJarvisDecision } from "@/services/jarvisAgent";
import { PlannerItemEditError } from "@/services/plannerItemEdit";

const TZ = "Europe/Moscow";
const ID = "5b0d8c52-3f0e-4c3a-9a51-2b7f4f1d9e10";

function ride(startIso: string, minutes: number, watts: number | null, load: number) {
  return {
    startAt: new Date(startIso),
    movingTimeS: minutes * 60,
    elapsedTimeS: minutes * 60,
    raw: { icu_training_load: load, ...(watts ? { icu_average_watts: watts } : {}) },
  };
}

// Friday evening: two Zwift workouts with an 8-minute break (21:49 and 22:33 Moscow).
const FRIDAY = [
  ride("2026-10-16T18:49:00Z", 36, 178, 24),
  ride("2026-10-16T19:33:00Z", 85, 194, 63),
];
const SATURDAY_MORNING = new Date("2026-10-17T06:19:00Z");

describe("who answered in the chat", () => {
  it("names Claude and GPT models in plain words", () => {
    expect(chatModelLabel({ engine: "claude", model: "claude-opus-5-5" })).toBe("Claude Opus 5.5");
    expect(chatModelLabel({ model: "claude-sonnet-4-5-20250929" })).toBe("Claude Sonnet 4.5");
    expect(chatModelLabel({ model: "gpt-4.1-2025-04-14" })).toBe("GPT-4.1");
    expect(chatModelLabel({ model: "gpt-4o-mini", fallback: true })).toBe("GPT-4o mini (запасной)");
    expect(chatModelLabel({ engine: "system" })).toBe("Система");
    expect(chatModelLabel({})).toBeNull();
  });
});

describe("recent training load", () => {
  it("treats back-to-back rides as one training", () => {
    const [session] = groupTrainingSessions(FRIDAY);
    expect(session.minutes).toBe(121);
    expect(session.parts).toEqual([36, 85]);
    expect(session.watts).toBe(189);
    expect(session.load).toBe(87);
  });

  it("keeps rides hours apart as separate trainings", () => {
    const sessions = groupTrainingSessions([
      ride("2026-10-16T06:00:00Z", 40, 180, 30),
      ride("2026-10-16T18:49:00Z", 36, 178, 24),
    ]);
    expect(sessions).toHaveLength(2);
  });

  it("says how long ago the last training ended and what each day had", () => {
    const block = recentLoadBlock({ activities: FRIDAY, now: SATURDAY_MORNING, timezone: TZ });
    expect(block).toContain("Последняя тренировка закончилась 9 ч назад");
    expect(block).toContain("121 мин (36 + 85, одна тренировка)");
    expect(block).toContain("сб 17.10 (сегодня): без тренировок");
    expect(block).toContain("пт 16.10: 121 мин");
    expect(block).toContain("За 7 дней: 1 трен., 2 ч 1 мин, нагрузка 87.");
  });

  it("says so when there were no trainings", () => {
    expect(recentLoadBlock({ activities: [], now: SATURDAY_MORNING, timezone: TZ })).toContain(
      "Тренировок за последние недели нет",
    );
  });
});

describe("the conversation as the model reads it", () => {
  it("carries the local time and the author of every message", () => {
    const transcript = conversationTranscript(
      [
        {
          role: "user",
          content: "🔔 Новые тренировки",
          createdAt: new Date("2026-10-16T21:20:00Z"),
          metadata: { auto: true },
        },
        {
          role: "assistant",
          content: "Завтра — отдых или лёгкая.",
          createdAt: new Date("2026-10-16T21:20:10Z"),
          metadata: { model: "gpt-4.1-2025-04-14" },
        },
        {
          role: "user",
          content: "Что делать сегодня?",
          createdAt: SATURDAY_MORNING,
          metadata: {},
        },
      ],
      TZ,
      "JARVIS",
    );
    expect(transcript).toContain("[сб 17.10 00:20] Система: 🔔 Новые тренировки");
    expect(transcript).toContain("[сб 17.10 00:20] JARVIS (GPT-4.1): Завтра — отдых или лёгкая.");
    expect(transcript).toContain("[сб 17.10 09:19] Владелец: Что делать сегодня?");
  });
});

describe("honest JARVIS answers", () => {
  it("puts what really happened before the model's words", () => {
    const answer = composeJarvisAnswer({
      reply: "Сегодня лёгкая: вчера было 2 часа.",
      done: [],
      failed: ["⚠️ Не получилось изменить «Длинная Z2»: не понял напоминания"],
    });
    expect(answer.startsWith("⚠️ Не получилось изменить «Длинная Z2»")).toBe(true);
    expect(answer).toContain("Сегодня лёгкая");
  });

  it("explains failures in plain words, with the item's name", () => {
    const action = parseJarvisDecision({
      reply: "",
      actions: [{ type: "update_item", item_id: ID, clear_reminders: true }],
    }).actions[0];
    expect(action.clear_reminders).toBe(true);
    expect(failureLine(action, new PlannerItemEditError("not_found"), "Длинная Z2")).toBe(
      "⚠️ Не получилось изменить «Длинная Z2»: не нашёл это дело — возможно, оно уже удалено или выполнено",
    );
    expect(failureLine(action, new Error("сбой сети"))).toBe(
      "⚠️ Не получилось изменить: сбой сети",
    );
  });
});

describe("chat history export", () => {
  it("lists every message with time, author, model, actions and closed threads", () => {
    const archivedAt = new Date("2026-10-16T10:00:00Z");
    const text = formatCoachChatExport({
      timezone: TZ,
      now: SATURDAY_MORNING,
      messages: [
        {
          role: "user",
          content: "Старый вопрос",
          status: "archived",
          metadata: {},
          createdAt: new Date("2026-10-15T08:00:00Z"),
          updatedAt: archivedAt,
        },
        {
          role: "user",
          content: "Поставь тренировку",
          status: "active",
          metadata: {},
          createdAt: new Date("2026-10-17T06:19:55Z"),
          updatedAt: new Date("2026-10-17T06:19:55Z"),
        },
        {
          role: "assistant",
          content: "Исправил.",
          status: "active",
          metadata: {
            engine: "claude",
            model: "claude-sonnet-5-5",
            done: [],
            failed: ["⚠️ Не получилось (update_item): reminders_not_understood"],
          },
          createdAt: new Date("2026-10-17T06:26:52Z"),
          updatedAt: new Date("2026-10-17T06:26:52Z"),
        },
      ],
    });
    expect(text).toContain("Сообщений: 3.");
    expect(text).toContain("## Разговор (закрыт кнопкой «Новый разговор»)");
    expect(text).toContain("## Текущий разговор");
    expect(text).toContain("### сб 17.10.2026 09:19 — Вы");
    expect(text).toContain("### сб 17.10.2026 09:26 — JARVIS · Claude Sonnet 5.5");
    expect(text).toContain("- ⚠️ Не получилось (update_item): reminders_not_understood");
  });
});
