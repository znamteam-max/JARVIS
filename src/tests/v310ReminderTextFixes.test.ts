import { describe, expect, it } from "vitest";

import { formatReminderMessage } from "@/bot/formatters";
import type { Reminder, ReminderPolicy } from "@/db/schema";
import { extractOpenEndedUntilDoneTitle } from "@/domain/openEndedUntilDoneIntent";

describe("V3.1.0 reminder text fixes", () => {
  it("strips 'пока не отмечу сделанным' completely from the title", () => {
    // Production 2026-10-15: the task was saved as "…разбирают ошибки, , сделанным".
    const title = extractOpenEndedUntilDoneTitle(
      "Создать анализатор всех продуктов канала, который смотрят и слушает все выпуски, проверяют интеграции, разбирают ошибки, напоминай мне каждые 4 часа, пока не отмечу сделанным",
    );

    expect(title).toBe(
      "Создать анализатор всех продуктов канала, который смотрят и слушает все выпуски, проверяют интеграции, разбирают ошибки",
    );
  });

  it("names the policy when a reminder has no planner item", () => {
    const text = formatReminderMessage({ payload: {} } as unknown as Reminder, null, {
      policy: { title: "Посмотреть верстку на НБА" } as unknown as ReminderPolicy,
    });

    expect(text).toBe("Напоминание: Посмотреть верстку на НБА");
  });

  it("falls back to the reminder payload title without a policy", () => {
    const text = formatReminderMessage(
      { payload: { title: "Позвонить юристу" } } as unknown as Reminder,
      null,
    );

    expect(text).toBe("Напоминание: Позвонить юристу");
  });
});
