import { describe, expect, it } from "vitest";

import { clockTimesIn, editableItemsBlock, parseJarvisDecision } from "@/services/jarvisAgent";

const ID = "5b0d8c52-3f0e-4c3a-9a51-2b7f4f1d9e10";

describe("JARVIS decision from Claude", () => {
  it("keeps valid actions and the reply", () => {
    const decision = parseJarvisDecision({
      reply: "Поставил напоминание на 21 октября, 10:00.",
      actions: [
        {
          type: "create_item",
          kind: "task",
          title: "Оплатить кружок",
          date: "2026-10-21",
          time: "10:00",
          reminders: ["at_time"],
          item_id: null,
        },
      ],
    });
    expect(decision.reply).toContain("21 октября");
    expect(decision.invalid).toBe(0);
    expect(decision.actions[0]).toMatchObject({ type: "create_item", title: "Оплатить кружок" });
  });

  it("drops malformed actions instead of guessing", () => {
    const decision = parseJarvisDecision({
      reply: "Готово",
      actions: [
        { type: "delete_item", item_id: "not-a-uuid" },
        { type: "create_item", title: "Встреча", date: "21.10.2026" },
        { type: "explode_server" },
        { type: "complete_item", item_id: ID },
      ],
    });
    expect(decision.actions).toEqual([{ type: "complete_item", item_id: ID }]);
    expect(decision.invalid).toBe(3);
  });

  it("survives an empty or broken answer", () => {
    expect(parseJarvisDecision(null)).toEqual({ reply: "", actions: [], invalid: 0 });
    expect(parseJarvisDecision({ reply: 5, actions: "nope" })).toEqual({
      reply: "",
      actions: [],
      invalid: 0,
    });
  });

  it("caps the number of actions per message", () => {
    const actions = Array.from({ length: 9 }, () => ({ type: "complete_item", item_id: ID }));
    expect(parseJarvisDecision({ reply: "", actions }).actions).toHaveLength(5);
  });
});

describe("what JARVIS may touch", () => {
  it("lists only the owner's own items, with ids and reminders", () => {
    const block = editableItemsBlock([
      {
        title: "Скоро",
        note: null,
        rows: [
          {
            number: 1,
            text: "Ср, 21.10 16:00–17:00 · Приход с Робом к ортодонту",
            details: ["🔔 за час"],
            item: {
              id: ID,
              title: "Приход с Робом к ортодонту",
              kind: "event",
              startLocal: "2026-10-21T16:00",
              endLocal: "2026-10-21T17:00",
              dueLocal: null,
            },
          },
          { number: 2, text: "Событие из Яндекс.Календаря", details: [], item: null },
        ],
      },
    ]);
    expect(block).toContain(
      `${ID} | Скоро: Ср, 21.10 16:00–17:00 · Приход с Робом к ортодонту (🔔 за час)`,
    );
    expect(block).not.toContain("Яндекс");
  });
});

describe("reminders at exact times", () => {
  it("takes a list of local times for each day", () => {
    const decision = parseJarvisDecision({
      reply: "",
      actions: [
        {
          type: "create_item",
          kind: "task",
          title: "Подготовка по платформе WOW",
          date: "2026-10-19",
          time: "23:00",
          reminders: [],
          reminder_at: ["2026-10-19T11:00", "2026-10-19T17:00"],
        },
      ],
    });
    expect(decision.invalid).toBe(0);
    expect(decision.actions[0].reminder_at).toEqual(["2026-10-19T11:00", "2026-10-19T17:00"]);
  });

  it("finds clock times in words the reminder parser did not take", () => {
    expect(clockTimesIn("в 11:00 и в 17:00")).toEqual(["11:00", "17:00"]);
    expect(clockTimesIn("утром в 9.30, вечером в 21:05")).toEqual(["09:30", "21:05"]);
    expect(clockTimesIn("каждый час")).toEqual([]);
    expect(clockTimesIn(null)).toEqual([]);
  });
});
