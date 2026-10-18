import { describe, expect, it } from "vitest";

import { parseIntervalsCommand } from "@/athleteBot/handlers";
import { athleteWebhookSecret } from "@/athleteBot/telegram";
import { formatDistanceAndPace } from "@/domain/stravaActivity";
import { markdownToTelegramChunks, telegramHtmlToPlain } from "@/domain/telegramHtml";
import { athleteFtp, isAthlete, TRIATHLON_COACH_INSTRUCTIONS } from "@/services/coach";

describe("coach answers in Telegram", () => {
  it("turns tables into aligned monospace and keeps bold", () => {
    const [chunk] = markdownToTelegramChunks(
      [
        "## План на неделю",
        "**Главное:** база, без интенсивности.",
        "",
        "| День | Тренировка | Пульс |",
        "|---|---|---|",
        "| Пн | Плавание 2 км | <150 |",
        "| Вт | Бег 45 мин | 140–150 |",
        "",
        "- сон 8 ч",
      ].join("\n"),
    );
    expect(chunk).toContain("<b>План на неделю</b>");
    expect(chunk).toContain("<b>Главное:</b> база");
    expect(chunk).toContain("<pre>День  Тренировка     Пульс\nПн    Плавание 2 км  &lt;150");
    expect(chunk).not.toContain("|---");
    expect(chunk).toContain("• сон 8 ч");
  });

  it("splits a long answer between blocks, never inside a table", () => {
    const paragraph = "Длинный абзац о подготовке. ".repeat(60);
    const chunks = markdownToTelegramChunks(
      [paragraph, paragraph, "| A | B |\n|---|---|\n| 1 | 2 |", paragraph].join("\n\n"),
      2000,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("<pre>A  B\n1  2</pre>"))).toBe(true);
  });

  it("falls back to plain text without tags", () => {
    expect(telegramHtmlToPlain("<b>Пульс</b> &lt;150 &amp; темп")).toBe("Пульс <150 & темп");
  });
});

describe("connecting Intervals.icu", () => {
  it("reads the athlete id and the key from one line", () => {
    const parsed = parseIntervalsCommand("/intervals i123456 not_real_000");
    expect(parsed?.athleteId).toBe("i123456");
    expect(Object.values(parsed ?? {})).toEqual(["i123456", "not_real_000"]);
    expect(parseIntervalsCommand("/intervals 123456 not_real_000")?.athleteId).toBe("i123456");
    expect(parseIntervalsCommand("/intervals@coach_bot I98765 not_real_000")?.athleteId).toBe(
      "i98765",
    );
  });

  it("refuses anything that is not an id and a key", () => {
    expect(parseIntervalsCommand("/intervals")).toBeNull();
    expect(parseIntervalsCommand("/intervals мой ключ")).toBeNull();
    expect(parseIntervalsCommand("/intervals i123 short")).toBeNull();
  });
});

describe("the athlete's coach", () => {
  it("is a triathlon coach that asks for the profile", () => {
    expect(TRIATHLON_COACH_INSTRUCTIONS).toContain("70.3");
    expect(TRIATHLON_COACH_INSTRUCTIONS).toContain("/profile");
    expect(isAthlete({ role: "athlete" })).toBe(true);
    expect(isAthlete({ role: "owner" })).toBe(false);
  });

  it("takes FTP from /ftp first, then from Intervals.icu, never invents one", () => {
    const rides = [{ raw: { icu_ftp: 190 } }, { raw: { icu_ftp: 205 } }];
    expect(athleteFtp({ ftp: 215 }, rides)).toBe(215);
    expect(athleteFtp({}, rides)).toBe(205);
    expect(athleteFtp({}, [{ raw: {} }])).toBeNull();
  });

  it("shows pace per km for runs and per 100 m for swims", () => {
    expect(formatDistanceAndPace({ sportType: "Run", distanceM: 10000, movingTimeS: 3320 })).toBe(
      "10,0 км, 5:32 /км",
    );
    expect(formatDistanceAndPace({ sportType: "Swim", distanceM: 1500, movingTimeS: 1875 })).toBe(
      "1,5 км, 2:05 /100 м",
    );
    expect(
      formatDistanceAndPace({ sportType: "WeightTraining", distanceM: 0, movingTimeS: 1 }),
    ).toBeNull();
  });
});

describe("coach bot webhook", () => {
  it("derives a stable secret from the token without revealing it", () => {
    const secret = athleteWebhookSecret("123:ABC");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).toBe(athleteWebhookSecret("123:ABC"));
    expect(secret).not.toBe(athleteWebhookSecret("123:ABD"));
    expect(secret).not.toContain("ABC");
  });
});
