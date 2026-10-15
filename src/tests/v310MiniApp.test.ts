import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeCalorieBudget,
  DEFAULT_NUTRITION_GOALS,
  parsePlanSections,
  scaleFoodItems,
} from "@/domain/miniapp";
import { verifyTelegramInitData } from "@/lib/telegramWebApp";

const BOT_TOKEN = "123456:test-token";

function signedInitData(fields: Record<string, string>) {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("V3.1.0 Telegram Mini App", () => {
  it("splits the bot's plan message into the same sections", () => {
    const sections = parsePlanSections(
      [
        "JARVIS · План",
        "",
        "Сегодня — события:",
        "На сегодня нет событий.",
        "",
        "Сегодня — задачи:",
        "<b>1</b> · до 10:00 · Посмотреть верстку на НБА",
        "   ⏰ каждый час, с 06:00 до 09:00",
        "",
        "Долгосрочные правила:",
        "<b>2</b> · Внести показания счетчиков за квартиру",
        "   ↻ 15–19 числа каждого месяца в 12:00",
        "",
        "Нажми номер, чтобы открыть пункт.",
      ].join("\n"),
    );

    expect(sections).toEqual([
      { title: "Сегодня — события", rows: [], note: "На сегодня нет событий." },
      {
        title: "Сегодня — задачи",
        rows: [
          {
            number: 1,
            text: "до 10:00 · Посмотреть верстку на НБА",
            details: ["⏰ каждый час, с 06:00 до 09:00"],
          },
        ],
        note: null,
      },
      {
        title: "Долгосрочные правила",
        rows: [
          {
            number: 2,
            text: "Внести показания счетчиков за квартиру",
            details: ["↻ 15–19 числа каждого месяца в 12:00"],
          },
        ],
        note: null,
      },
    ]);
  });

  it("adds the chosen share of workout calories to the day's target", () => {
    expect(
      computeCalorieBudget({
        goals: DEFAULT_NUTRITION_GOALS,
        eaten: { calories: 525, proteinG: 39, fatG: 10, carbsG: 59 },
        workoutCalories: 612,
      }),
    ).toEqual({ target: 2406, bonus: 306, eaten: 525, remaining: 1881, progress: 525 / 2406 });
  });

  it("rescales an edited ingredient and drops zeroed ones", () => {
    const result = scaleFoodItems(
      [
        { name: "Курица", grams: 150, calories: 220, proteinG: 30, fatG: 5, carbsG: 0 },
        { name: "Лаваш", grams: 100, calories: 280, proteinG: 8, fatG: 5, carbsG: 54 },
        { name: "Соус", grams: 30, calories: 90, proteinG: 0, fatG: 9, carbsG: 2 },
      ],
      [150, 50, 0],
    );

    expect(result.items.map((item) => [item.name, item.grams, item.calories])).toEqual([
      ["Курица", 150, 220],
      ["Лаваш", 50, 140],
    ]);
    expect(result.totals.calories).toBe(360);
  });

  it("accepts genuine Telegram launch data and rejects tampering or stale data", () => {
    const fields = { auth_date: "1792100000", user: JSON.stringify({ id: 52203584 }) };
    const initData = signedInitData(fields);

    expect(verifyTelegramInitData({ initData, botToken: BOT_TOKEN, nowS: 1792100100 })).toEqual({
      telegramUserId: "52203584",
    });
    expect(
      verifyTelegramInitData({
        initData: initData.replace("52203584", "52203585"),
        botToken: BOT_TOKEN,
        nowS: 1792100100,
      }),
    ).toBeNull();
    expect(
      verifyTelegramInitData({ initData, botToken: BOT_TOKEN, nowS: 1792100000 + 2 * 86400 }),
    ).toBeNull();
  });
});
