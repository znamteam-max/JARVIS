import { describe, expect, it } from "vitest";

import { parseItemEditMutation } from "@/services/itemEditMutations";
import { parseRussianDateTime } from "@/services/russianDateTime";
import type { PlannerItem } from "@/db/schema";

const timezone = "Europe/Moscow";
const now = new Date("2026-09-26T04:26:41.000Z");

function local(text: string) {
  return parseRussianDateTime({ text, timezone, now })?.local.toFormat("yyyy-LL-dd HH:mm");
}

describe("V3.0.9 Russian dates from the 25.09–09.10 journal", () => {
  it.each([
    ["27 октября, 18.10", "2026-10-27 18:10"],
    ["Перенести на 27 октября на 18:10", "2026-10-27 18:10"],
    ["Составить топ-30 игроков НБА, дедлайн 23.30 в воскресенье 4 октября", "2026-10-04 23:30"],
    ["1 мая 2027 в 9:00", "2027-05-01 09:00"],
    ["созвон 3 окт. в 12:00", "2026-10-03 12:00"],
    ["18.10 в 15:00", "2026-10-18 15:00"],
    ["на 18.10", "2026-10-18 08:00"],
    ["в 18.10", "2026-09-26 18:10"],
  ])("%s -> %s", (text, expected) => {
    expect(local(text)).toBe(expected);
  });

  it("does not read counted nouns as months", () => {
    expect(local("купить 3 марки и 2 майки")).toBeUndefined();
  });

  it("moves an event to the named date and keeps its duration", () => {
    const item = {
      id: "item-id",
      kind: "event",
      title: "Брекеты",
      timezone,
      startAt: new Date("2026-09-25T15:00:00.000Z"),
      endAt: new Date("2026-09-25T16:00:00.000Z"),
      dueAt: null,
      metadata: {},
    } as unknown as PlannerItem;

    for (const text of ["27 октября, 18.10", "Перенести на 27 октября на 18:10"]) {
      const mutation = parseItemEditMutation({ text, item, timezone, now });
      expect(mutation.scheduledForLocal, text).toBe("2026-10-27T18:10:00+03:00");
      expect(mutation.endsAtLocal ?? null, text).toBeNull();
    }
  });
});

describe("V3.0.9 scheduled creation titles from the journal", () => {
  it.each([
    [
      "В четверг в 11.00 прямой эфир Централ Парк про триатлон",
      "Прямой эфир Централ Парк про триатлон",
      "2026-10-08 11:00",
    ],
    ["Завтра в 13.00 созвон по Централ Парк", "Созвон по Централ Парк", "2026-10-06 13:00"],
    ["Созвон по СММ на НХЛ 27 октября в 14.00", "Созвон по СММ на НХЛ", "2026-10-27 14:00"],
  ])("%s", async (text, title, start) => {
    const { parseScheduledCreationIntent } = await import("@/domain/scheduledCreationIntent");
    const intent = parseScheduledCreationIntent({
      text,
      timezone,
      now: new Date("2026-10-05T10:44:50.000Z"),
    });
    expect(intent?.title).toBe(title);
    expect(intent?.startLocal.slice(0, 16).replace("T", " ")).toBe(start);
  });
});

describe("V3.0.9 deadline without a clock", () => {
  it.each([
    [
      "Сделать видео с Сэмом, дедлайн до завтра",
      "2026-10-08T12:26:24.000Z",
      "2026-10-09 23:59",
      "Сделать видео с Сэмом",
    ],
    [
      "Составить топ-30 игроков НБА, дедлайн 23.30 в воскресенье 4 октября",
      "2026-10-03T09:03:05.000Z",
      "2026-10-04 23:30",
      "Составить топ-30 игроков НБА",
    ],
  ])("%s", async (text, sentAt, due, title) => {
    const { parseDeadlineSemantics } = await import("@/domain/deadlineSemantics");
    const parsed = parseDeadlineSemantics({ text, timezone, now: new Date(sentAt) });
    expect(parsed?.dueLocal.toFormat("yyyy-LL-dd HH:mm")).toBe(due);
    expect(parsed?.title).toBe(title);
  });
});
