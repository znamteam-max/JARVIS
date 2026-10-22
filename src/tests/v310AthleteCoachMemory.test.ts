import { describe, expect, it } from "vitest";

import { HISTORY_INSTRUCTION, welcomeDue, welcomeInstruction } from "@/athleteBot/claudeWelcome";
import { classifyAthleteFile, safeError } from "@/athleteBot/handlers";
import { normalizeFact } from "@/db/queries/coachMemory";
import type { HealthItem } from "@/db/schema";
import { healthRecordsBlock, healthRecordsList, memoryBlock } from "@/domain/athleteMemory";
import { athleteNormsBlock, parseIntervalsAthlete } from "@/domain/athleteNorms";
import {
  ATHLETE_MEMORY_RULES,
  conversationTranscript,
  TRIATHLON_COACH_INSTRUCTIONS,
} from "@/services/coach";
import { continuesRecord, mergeHealthItems, validLabDate } from "@/services/healthDocuments";

// Every value here is made up: this repository is public.

function run(averageHeartrate: number, minutes: number, km: number) {
  return {
    sportType: "Run",
    movingTimeS: minutes * 60,
    distanceM: km * 1000,
    averageHeartrate,
    raw: {},
  };
}

const item = (name: string, value: string, flag: string, unit = "г/л"): HealthItem => ({
  name,
  value,
  unit,
  reference: "100-200",
  flag,
});

describe("her own norms, not textbook ones", () => {
  it("tells the coach what heart rate is usual for her on runs", () => {
    const block = athleteNormsBlock({
      activities: [run(150, 30, 5), run(152, 60, 10), run(154, 45, 7.5), run(156, 40, 6)],
      restingHr: [50, 52, 54, 56],
      intervals: null,
    });
    expect(block).toContain("Бег: 4 трен.");
    expect(block).toMatch(/средний пульс обычно 15\d–15\d/);
    expect(block).toContain("Пульс покоя по часам за 2 недели: 50–56");
    expect(block).toContain("а не по общим формулам");
  });

  it("reads threshold HR, max HR and zones from Intervals.icu", () => {
    const parsed = parseIntervalsAthlete({
      icu_resting_hr: 55,
      sportSettings: [
        { types: ["Run"], lthr: 170, max_hr: 188, hr_zones: [130, 145, 160, 170, 188] },
        { types: ["Swim"] },
      ],
    });
    expect(parsed.restingHr).toBe(55);
    expect(parsed.sports).toHaveLength(1);
    const block = athleteNormsBlock({ activities: [], restingHr: [], intervals: parsed });
    expect(block).toContain("пороговый пульс 170, максимальный 188");
    expect(block).toContain("130/145/160/170/188");
  });

  it("survives an empty or odd Intervals answer", () => {
    expect(parseIntervalsAthlete(null)).toEqual({ sports: [], restingHr: null });
    expect(athleteNormsBlock({ activities: [], restingHr: [], intervals: null })).toContain(
      "Пока мало данных",
    );
  });
});

describe("what she told the coach stays in sight", () => {
  it("lists her own facts one per line, as stored", () => {
    const block = memoryBlock([{ fact: "Любит плавать по утрам" }, { fact: "Нет велостанка" }]);
    expect(block).toContain("- Любит плавать по утрам\n- Нет велостанка");
    expect(block).toContain("её слова о себе важнее общих норм");
  });

  it("finds a fact to forget even with a copied number, dash or date", () => {
    const stored = normalizeFact("Любит плавать по утрам");
    expect(normalizeFact("2. Любит плавать по утрам")).toBe(stored);
    expect(normalizeFact("- любит плавать по утрам (12.03)")).toBe(stored);
    expect(normalizeFact("Ёлка")).toBe(normalizeFact("елка"));
  });

  it("the coach is told to keep facts, judge by her norms and keep it private", () => {
    expect(ATHLETE_MEMORY_RULES).toContain("remember");
    expect(ATHLETE_MEMORY_RULES).toContain("forget");
    expect(TRIATHLON_COACH_INSTRUCTIONS).toContain("относительно «Её норм»");
    expect(TRIATHLON_COACH_INSTRUCTIONS).toContain("в мужском роде");
    expect(TRIATHLON_COACH_INSTRUCTIONS).toContain("видит только она");
  });
});

describe("analyses", () => {
  const records = [
    {
      takenOn: "2030-02-01",
      lab: "Лаборатория",
      title: "Железо",
      items: [item("Железо", "250", "high"), item("Ферритин", "150", "normal")],
      summary: "Железо выше нормы.",
    },
    {
      takenOn: "2030-01-01",
      lab: null,
      title: "Кровь",
      items: [item("Гемоглобин", "90", "low")],
      summary: "Гемоглобин ниже нормы.",
    },
  ];

  it("gives the coach every value with its norm and a mark when outside", () => {
    const block = healthRecordsBlock(records);
    expect(block).toContain("01.02.2030 · Железо (Лаборатория)");
    expect(block).toContain("Железо 250 г/л (норма 100-200) ↑");
    expect(block).toContain("Гемоглобин 90 г/л (норма 100-200) ↓");
  });

  it("lists them for her, numbered, with what is outside the norm", () => {
    expect(healthRecordsList(records)).toBe(
      "1. 01.02.2030 — Железо (2 показ.; вне нормы: Железо ↑)\n2. 01.01.2030 — Кровь (1 показ.; вне нормы: Гемоглобин ↓)",
    );
  });

  it("joins parts of one result: same date or no date, a line seen twice kept once", () => {
    const merged = mergeHealthItems(
      [item("Гемоглобин", "90", "low")],
      [item("гемоглобин", "90", "low"), item("Тромбоциты", "300", "normal", "10^9/л")],
    );
    expect(merged.map((entry) => entry.name)).toEqual(["Гемоглобин", "Тромбоциты"]);
    expect(continuesRecord({ takenOn: "2030-01-01" }, { takenOn: "2030-01-01" })).toBe(true);
    expect(continuesRecord({ takenOn: "2030-01-01" }, { takenOn: null })).toBe(true);
    expect(continuesRecord({ takenOn: "2030-01-01" }, { takenOn: "2030-02-01" })).toBe(false);
  });

  it("keeps only real dates", () => {
    expect(validLabDate("2030-01-31")).toBe("2030-01-31");
    expect(validLabDate("2030-02-30")).toBeNull();
    expect(validLabDate("")).toBeNull();
  });
});

describe("files in her chat", () => {
  it("knows workouts, analyses and the rest apart", () => {
    expect(classifyAthleteFile({ photo: [{}] })).toEqual({
      kind: "health",
      mediaType: "image/jpeg",
    });
    expect(classifyAthleteFile({ document: { file_name: "ride.FIT" } })?.kind).toBe("fit");
    expect(
      classifyAthleteFile({ document: { file_name: "a.pdf", mime_type: "application/pdf" } }),
    ).toEqual({ kind: "health", mediaType: "application/pdf" });
    expect(
      classifyAthleteFile({ document: { file_name: "IMG.HEIC", mime_type: "image/heic" } })?.kind,
    ).toBe("unknown");
    expect(classifyAthleteFile({})).toBeNull();
  });

  it("logs a failed query without the data it carried", () => {
    const failed = new Error('Failed query: insert into "health_records" params: secret');
    expect(safeError(failed)).toBe("Error");
    expect(safeError(new Error("timeout"))).toBe("timeout");
  });
});

describe("the one-time welcome", () => {
  const now = new Date("2030-01-01T12:00:00Z");

  it("goes out once, retries a run that died, gives up after 3 tries", () => {
    expect(welcomeDue(undefined, now)).toBe(true);
    expect(welcomeDue({ sentAt: "2030-01-01T11:00:00Z" }, now)).toBe(false);
    expect(welcomeDue({ claimedAt: "2030-01-01T11:55:00Z", attempts: 1 }, now)).toBe(false);
    expect(welcomeDue({ claimedAt: "2030-01-01T11:40:00Z", attempts: 1 }, now)).toBe(true);
    expect(welcomeDue({ claimedAt: "2030-01-01T10:00:00Z", attempts: 3 }, now)).toBe(false);
  });

  it("uses what is really remembered and says who can see the chat", () => {
    const text = welcomeInstruction({ remembered: "Любит плавать по утрам", analyses: "1. …" });
    expect(text).toContain("«Любит плавать по утрам»");
    expect(text).toContain("видит только она");
    expect(welcomeInstruction({ remembered: null, analyses: "" })).not.toContain("Например");
  });

  it("reads her whole chat first and keeps what it learned about her", () => {
    expect(HISTORY_INSTRUCTION).toContain("всю вашу прошлую переписку");
    expect(HISTORY_INSTRUCTION).toContain("В remember");
    const transcript = conversationTranscript(
      [{ role: "user", content: "Привет", createdAt: now, metadata: {} }],
      "UTC",
      "Тренер",
      "Спортсменка",
      "Теперь напиши приветствие по инструкции.",
    );
    expect(transcript).toContain("Спортсменка: Привет");
    expect(transcript.endsWith("Теперь напиши приветствие по инструкции.")).toBe(true);
  });
});
