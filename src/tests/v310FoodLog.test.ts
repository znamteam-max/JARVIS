import { describe, expect, it } from "vitest";

import {
  applySimpleFoodCorrections,
  formatFoodDaySummary,
  formatFoodEstimateReply,
  normalizeFoodEstimate,
} from "@/domain/foodEstimate";

describe("V3.1.0 food photo calorie log", () => {
  it("sums the visible items into the total and cleans model noise", () => {
    const estimate = normalizeFoodEstimate({
      isFood: true,
      title: "гречка с курицей",
      items: [
        { name: "Гречка", grams: 200.4, calories: 220.2, proteinG: 8.4, fatG: 2, carbsG: 43 },
        { name: "Куриная грудка", grams: 150, calories: 248, proteinG: 46, fatG: 5.4, carbsG: 0 },
        { name: " ", grams: 10, calories: 50, proteinG: 0, fatG: 5, carbsG: 0 },
      ],
      calories: 999,
      proteinG: -3,
      fatG: 0,
      carbsG: 0,
      confidence: "medium",
      note: "  ",
    });

    expect(estimate).toEqual({
      isFood: true,
      title: "Гречка с курицей",
      items: [
        { name: "Гречка", grams: 200, calories: 220, proteinG: 8, fatG: 2, carbsG: 43 },
        { name: "Куриная грудка", grams: 150, calories: 248, proteinG: 46, fatG: 5, carbsG: 0 },
      ],
      calories: 468,
      proteinG: 54,
      fatG: 7,
      carbsG: 43,
      confidence: "medium",
      note: null,
    });
  });

  it("formats the reply with the running daily total", () => {
    const text = formatFoodEstimateReply({
      estimate: normalizeFoodEstimate({
        isFood: true,
        title: "Овсянка с бананом",
        items: [{ name: "Овсянка", grams: 250, calories: 310, proteinG: 10, fatG: 6, carbsG: 54 }],
        confidence: "high",
        note: "Сахар не видно — считал без него.",
      }),
      dayTotals: { calories: 1380, proteinG: 95, fatG: 40, carbsG: 150 },
      dayCount: 3,
    });

    expect(text).toBe(
      [
        "🍽 Овсянка с бананом",
        "≈ 310 ккал · Б 10 · Ж 6 · У 54",
        "• Овсянка ~250 г — 310 ккал",
        "",
        "ℹ️ Сахар не видно — считал без него.",
        "",
        "Оценка примерная (уверенность: высокая). Если ошибся — удали запись и пришли фото с подписью.",
        "",
        "За сегодня: 1 380 ккал · Б 95 · Ж 40 · У 150 (3 приёма)",
      ].join("\n"),
    );
  });

  it("says so when the photo is not food", () => {
    const text = formatFoodEstimateReply({
      estimate: normalizeFoodEstimate({ isFood: false, title: "Скриншот", items: [] }),
      dayTotals: { calories: 0, proteinG: 0, fatG: 0, carbsG: 0 },
      dayCount: 0,
    });

    expect(text).toContain("Не вижу на фото еды");
  });

  it("applies simple gram changes and removals without AI", () => {
    // Production 2026-10-15: shawarma with 100 g of lavash that was really about half.
    const shawarma = normalizeFoodEstimate({
      isFood: true,
      title: "Шаурма с курицей",
      items: [
        { name: "Курица нежирная", grams: 150, calories: 220, proteinG: 30, fatG: 5, carbsG: 0 },
        { name: "Лаваш", grams: 100, calories: 280, proteinG: 8, fatG: 5, carbsG: 54 },
        { name: "Овощи", grams: 50, calories: 25, proteinG: 1, fatG: 0, carbsG: 5 },
      ],
      confidence: "high",
      note: null,
    });

    const lighter = applySimpleFoodCorrections(shawarma, "лаваша 50 гр, курицы 200 г");
    expect(lighter?.items).toEqual([
      { name: "Курица нежирная", grams: 200, calories: 293, proteinG: 40, fatG: 7, carbsG: 0 },
      { name: "Лаваш", grams: 50, calories: 140, proteinG: 4, fatG: 3, carbsG: 27 },
      { name: "Овощи", grams: 50, calories: 25, proteinG: 1, fatG: 0, carbsG: 5 },
    ]);
    expect(lighter?.calories).toBe(458);

    const noVeg = applySimpleFoodCorrections(shawarma, "убери овощи");
    expect(noVeg?.items.map((item) => item.name)).toEqual(["Курица нежирная", "Лаваш"]);
    expect(noVeg?.calories).toBe(500);
  });

  it("leaves vague or additive corrections to the AI", () => {
    const shawarma = normalizeFoodEstimate({
      isFood: true,
      title: "Шаурма",
      items: [{ name: "Лаваш", grams: 100, calories: 280, proteinG: 8, fatG: 5, carbsG: 54 }],
    });

    expect(applySimpleFoodCorrections(shawarma, "курицы было больше")).toBeNull();
    expect(applySimpleFoodCorrections(shawarma, "добавь соус 30 г")).toBeNull();
    expect(applySimpleFoodCorrections(shawarma, "убери лаваш")).toBeNull();
  });

  it("lists the day's meals in local time", () => {
    const text = formatFoodDaySummary({
      timezone: "Europe/Moscow",
      now: new Date("2026-10-15T15:00:00.000Z"),
      entries: [
        {
          title: "Овсянка",
          eatenAt: new Date("2026-10-15T06:10:00.000Z"),
          calories: 310,
          proteinG: 10,
          fatG: 6,
          carbsG: 54,
        },
        {
          title: "Гречка с курицей",
          eatenAt: new Date("2026-10-15T10:30:00.000Z"),
          calories: 1070,
          proteinG: 85,
          fatG: 34,
          carbsG: 96,
        },
      ],
    });

    expect(text).toBe(
      [
        "🍽 Еда за 15.10",
        "• 09:10 Овсянка — 310 ккал",
        "• 13:30 Гречка с курицей — 1 070 ккал",
        "",
        "Итого: 1 380 ккал · Б 95 · Ж 40 · У 150",
      ].join("\n"),
    );
  });
});
