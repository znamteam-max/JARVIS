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
