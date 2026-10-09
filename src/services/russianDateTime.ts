import { DateTime } from "luxon";

const RU_CHARS = "\\u0430-\\u044f\\u0451";

const WORDS = {
  today: "\u0441\u0435\u0433\u043e\u0434\u043d\u044f",
  tomorrow: "\u0437\u0430\u0432\u0442\u0440\u0430",
  afterTomorrow: "\u043f\u043e\u0441\u043b\u0435\u0437\u0430\u0432\u0442\u0440\u0430",
} as const;

const WEEKDAYS: Array<{ aliases: string[]; weekday: number }> = [
  {
    aliases: [
      "\u043f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a",
      "\u043f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a\u0443",
      "\u043f\u043d",
    ],
    weekday: 1,
  },
  {
    aliases: [
      "\u0432\u0442\u043e\u0440\u043d\u0438\u043a",
      "\u0432\u0442\u043e\u0440\u043d\u0438\u043a\u0443",
      "\u0432\u0442",
    ],
    weekday: 2,
  },
  {
    aliases: [
      "\u0441\u0440\u0435\u0434\u0430",
      "\u0441\u0440\u0435\u0434\u0443",
      "\u0441\u0440",
    ],
    weekday: 3,
  },
  {
    aliases: [
      "\u0447\u0435\u0442\u0432\u0435\u0440\u0433",
      "\u0447\u0435\u0442\u0432\u0435\u0440\u0433\u0443",
      "\u0447\u0442",
    ],
    weekday: 4,
  },
  {
    aliases: [
      "\u043f\u044f\u0442\u043d\u0438\u0446\u0430",
      "\u043f\u044f\u0442\u043d\u0438\u0446\u0443",
      "\u043f\u0442",
    ],
    weekday: 5,
  },
  {
    aliases: [
      "\u0441\u0443\u0431\u0431\u043e\u0442\u0430",
      "\u0441\u0443\u0431\u0431\u043e\u0442\u0443",
      "\u0441\u0431",
    ],
    weekday: 6,
  },
  {
    aliases: [
      "\u0432\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c\u0435",
      "\u0432\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u0438\u044e",
      "\u0432\u0441",
    ],
    weekday: 7,
  },
];

export type RussianDateTimeParseResult = {
  local: DateTime;
  source: "explicit_date" | "weekday" | "relative_day" | "base_date" | "time_only";
  explicitToday: boolean;
  pastConfirmationRequired: boolean;
  usedNextWeek: boolean;
  warnings: string[];
};

export type RussianTimeRangeParseResult = {
  startLocal: DateTime;
  endLocal: DateTime;
  pastConfirmationRequired: boolean;
  warnings: string[];
};

export function parseRussianDateTime(params: {
  text: string;
  timezone: string;
  now?: Date;
  baseDate?: Date | null;
}): RussianDateTimeParseResult | null {
  const timezone = params.timezone;
  const nowLocal = DateTime.fromJSDate(params.now ?? new Date(), { zone: "utc" }).setZone(timezone);
  const text = normalizeRussian(params.text);
  const textWithoutQuotes = stripQuotedText(text);
  const namedDate = parseNamedMonthDate(textWithoutQuotes, nowLocal);
  const explicitDate = namedDate?.date ?? parseExplicitDate(textWithoutQuotes, nowLocal);
  const relative = parseRelativeDay(textWithoutQuotes, nowLocal);
  const weekday = parseWeekday(textWithoutQuotes);
  // With "27 октября" already naming the date, "18.10" can only be a clock time.
  const time = parseClockTime(namedDate ? namedDate.rest : textWithoutQuotes, {
    dottedTokensAreClock: Boolean(namedDate),
  });
  const warnings: string[] = [];

  if (!explicitDate && !relative && !weekday && !time) return null;
  if ((explicitDate || relative || weekday) && !time) warnings.push("time_missing_default_08_00");

  const clock = time ?? { hour: 8, minute: 0, source: "default" as const };
  let date: DateTime;
  let source: RussianDateTimeParseResult["source"];
  let explicitToday = false;
  let usedNextWeek = false;

  if (explicitDate) {
    date = explicitDate;
    source = "explicit_date";
  } else if (relative) {
    date = relative.date;
    source = "relative_day";
    explicitToday = relative.kind === "today";
  } else if (weekday) {
    const diffRaw = weekday.weekday - nowLocal.weekday;
    let daysAhead = diffRaw < 0 ? diffRaw + 7 : diffRaw;
    const candidate = nowLocal.plus({ days: daysAhead }).set({
      hour: clock.hour,
      minute: clock.minute,
      second: 0,
      millisecond: 0,
    });
    if (daysAhead === 0 && candidate <= nowLocal && !containsWord(textWithoutQuotes, WORDS.today)) {
      daysAhead = 7;
      usedNextWeek = true;
    }
    date = nowLocal.plus({ days: daysAhead });
    source = "weekday";
  } else if (params.baseDate) {
    date = DateTime.fromJSDate(params.baseDate, { zone: "utc" }).setZone(timezone);
    source = "base_date";
  } else {
    date = nowLocal;
    source = "time_only";
  }

  let local = date.set({
    hour: clock.hour,
    minute: clock.minute,
    second: 0,
    millisecond: 0,
  });
  const explicitTodayInText = explicitToday || containsWord(textWithoutQuotes, WORDS.today);
  if (
    explicitTodayInText &&
    clock.source === "bare" &&
    clock.hour >= 1 &&
    clock.hour <= 11 &&
    local <= nowLocal &&
    local.plus({ hours: 12 }) > nowLocal
  ) {
    local = local.plus({ hours: 12 });
    warnings.push("ambiguous_hour_assumed_pm");
  }

  return {
    local,
    source,
    explicitToday: explicitTodayInText,
    pastConfirmationRequired: explicitTodayInText && local <= nowLocal,
    usedNextWeek,
    warnings,
  };
}

export function parseRussianTimeRange(params: {
  text: string;
  timezone: string;
  now?: Date;
  baseDate?: Date | null;
}): RussianTimeRangeParseResult | null {
  const normalized = normalizeRussian(params.text);
  const match =
    normalized.match(
      /(?:\u0441|from)\s+(\d{1,2}(?:[.:]\d{2})?(?:\s+(?:\u0443\u0442\u0440\u0430|\u0434\u043d\u044f|\u0432\u0435\u0447\u0435\u0440\u0430|\u043d\u043e\u0447\u0438))?)\s+(?:\u0434\u043e|to)\s+(\d{1,2}(?:[.:]\d{2})?(?:\s+(?:\u0443\u0442\u0440\u0430|\u0434\u043d\u044f|\u0432\u0435\u0447\u0435\u0440\u0430|\u043d\u043e\u0447\u0438))?)/i,
    ) ??
    normalized.match(
      /(?:^|[^\d])(\d{1,2}[.:]\d{2})\s*[-\u2013\u2014]\s*(\d{1,2}[.:]\d{2})(?=$|[^\d])/i,
    );
  if (!match) return null;
  const date = parseRussianDateTime({
    ...params,
    text: `${normalized} \u0432 ${match[1]}`,
  });
  if (!date) return null;
  const endClock = parseStandaloneClock(match[2]);
  if (!endClock) return null;
  let endLocal = date.local.set({
    hour: endClock.hour,
    minute: endClock.minute,
    second: 0,
    millisecond: 0,
  });
  if (
    date.warnings.includes("ambiguous_hour_assumed_pm") &&
    endClock.source === "bare" &&
    endClock.hour >= 1 &&
    endClock.hour <= 11
  ) {
    endLocal = endLocal.plus({ hours: 12 });
  }
  if (endLocal <= date.local) endLocal = endLocal.plus({ days: 1 });
  return {
    startLocal: date.local,
    endLocal,
    pastConfirmationRequired: date.pastConfirmationRequired,
    warnings: date.warnings,
  };
}

function normalizeRussian(text: string) {
  return text.toLowerCase().replace(/\u0451/g, "\u0435").replace(/\s+/g, " ").trim();
}

function stripQuotedText(text: string) {
  return text.replace(/["\u00ab][^"\u00bb]+["\u00bb]/g, " ");
}

// Full month words or standard abbreviations only, so "3 марки" or "2 майки" stay plain numbers.
const MONTH_NAMES: Array<{ pattern: string; month: number }> = [
  { pattern: "январ[ья]|янв", month: 1 },
  { pattern: "феврал[ья]|февр?", month: 2 },
  { pattern: "марта?|мар", month: 3 },
  { pattern: "апрел[ья]|апр", month: 4 },
  { pattern: "ма[йя]", month: 5 },
  { pattern: "июн[ья]|июн", month: 6 },
  { pattern: "июл[ья]|июл", month: 7 },
  { pattern: "августа?|авг", month: 8 },
  { pattern: "сентябр[ья]|сент?", month: 9 },
  { pattern: "октябр[ья]|окт", month: 10 },
  { pattern: "ноябр[ья]|нояб?", month: 11 },
  { pattern: "декабр[ья]|дек", month: 12 },
];

const NAMED_MONTH_DATE = new RegExp(
  `(?:^|[^\\d])(\\d{1,2})\\s+(${MONTH_NAMES.map((entry) => entry.pattern).join("|")})\\.?(?:\\s+(\\d{4})(?:\\s*г(?:ода|\\.)?)?)?(?=$|[^${RU_CHARS}a-z\\d])`,
  "i",
);

// "27 октября", "27 окт.", "1 мая 2027"; returns the text without the date so its
// day number is never re-read as an hour ("на 27 октября").
function parseNamedMonthDate(text: string, nowLocal: DateTime) {
  const match = text.match(NAMED_MONTH_DATE);
  if (!match) return null;
  const monthWord = match[2]!.toLowerCase();
  const month = MONTH_NAMES.find((entry) =>
    new RegExp(`^(?:${entry.pattern})$`, "i").test(monthWord),
  )?.month;
  if (!month) return null;
  const day = Number(match[1]);
  const year = match[3] ? Number(match[3]) : nowLocal.year;
  let date = DateTime.fromObject({ year, month, day }, { zone: nowLocal.zoneName ?? "utc" });
  if (!date.isValid) return null;
  if (!match[3] && date.endOf("day") < nowLocal) date = date.plus({ years: 1 });
  return { date, rest: text.replace(match[0], " ") };
}

const CLOCK_PREPOSITION = /(?:^|\s)(?:в|во)\s*$/i;

function isPrepositionedClock(text: string, index: number, hour: string, minute: string) {
  return (
    minute.length === 2 &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    CLOCK_PREPOSITION.test(text.slice(0, index))
  );
}

function parseExplicitDate(text: string, nowLocal: DateTime) {
  const match = [...text.matchAll(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g)].find(
    (candidate) =>
      Boolean(candidate[3]) ||
      !isPrepositionedClock(text, candidate.index ?? 0, candidate[1]!, candidate[2]!),
  );
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = match[3] ? Number(match[3]) : nowLocal.year;
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  let date = DateTime.fromObject({ year, month, day }, { zone: nowLocal.zoneName ?? "utc" });
  if (!date.isValid) return null;
  if (!match[3] && date.endOf("day") < nowLocal) date = date.plus({ years: 1 });
  return date;
}

function parseRelativeDay(text: string, nowLocal: DateTime) {
  if (containsWord(text, WORDS.afterTomorrow)) {
    return { kind: "after_tomorrow", date: nowLocal.plus({ days: 2 }) };
  }
  if (containsWord(text, WORDS.tomorrow)) return { kind: "tomorrow", date: nowLocal.plus({ days: 1 }) };
  if (containsWord(text, WORDS.today)) return { kind: "today", date: nowLocal };
  return null;
}

function parseWeekday(text: string) {
  for (const entry of WEEKDAYS) {
    if (entry.aliases.some((alias) => containsWord(text, alias))) return { weekday: entry.weekday };
  }
  return null;
}

function parseClockTime(text: string, options?: { dottedTokensAreClock?: boolean }) {
  const sanitized = text.replace(
    /\b(\d{1,2})[./-](\d{1,2})([./-]\d{2,4})?\b/g,
    (match, hour: string, month: string, year: string | undefined, offset: number) => {
      if (!year && (options?.dottedTokensAreClock || isPrepositionedClock(text, offset, hour, month))) {
        return match;
      }
      const monthNumber = Number(month);
      return monthNumber >= 1 && monthNumber <= 12 ? " " : match;
    },
  );
  const withMinutes = sanitized.match(
    /(?:^|[^\d])(?:\u0432|\u0432\u043e|\u043a|\u043d\u0430|\u0441)?\s*(\d{1,2})[.:](\d{2})(?=$|[^\d])/i,
  );
  if (withMinutes) return normalizeClock(Number(withMinutes[1]), Number(withMinutes[2]), sanitized, "explicit");

  const dayPart = sanitized.match(
    /(?:^|[^\d])(\d{1,2})\s*(?:\u0447\u0430\u0441(?:\u0430|\u043e\u0432)?\s*)?(\u0443\u0442\u0440\u0430|\u0432\u0435\u0447\u0435\u0440\u0430|\u0434\u043d\u044f|\u043d\u043e\u0447\u0438)(?=$|[^\u0430-\u044fa-z])/i,
  );
  if (dayPart) return normalizeClock(Number(dayPart[1]), 0, dayPart[2], "explicit");

  const bare = sanitized.match(
    /(?:^|[^\d])(?:\u0432|\u0432\u043e|\u043a|\u043d\u0430|\u0441)\s+(\d{1,2})(?!\s*[.:]\d|\d)(?=$|[^\d])/i,
  );
  if (bare) return normalizeClock(Number(bare[1]), 0, sanitized, "bare");
  return null;
}

function normalizeClock(
  hourInput: number,
  minuteInput: number,
  context: string,
  source: "explicit" | "bare",
) {
  if (!Number.isFinite(hourInput) || !Number.isFinite(minuteInput)) return null;
  let hour = Math.max(0, Math.min(23, hourInput));
  const minute = Math.max(0, Math.min(59, minuteInput));
  if (/(?:^|\s)(?:\u0432\u0435\u0447\u0435\u0440\u0430|\u0434\u043d\u044f)(?:$|\s)/i.test(context) && hour < 12) {
    hour += 12;
  }
  if (/(?:^|\s)\u043d\u043e\u0447\u0438(?:$|\s)/i.test(context) && hour === 12) hour = 0;
  if (/(?:^|\s)\u0443\u0442\u0440\u0430(?:$|\s)/i.test(context) && hour === 12) hour = 0;
  return { hour, minute, source };
}

function parseStandaloneClock(value: string) {
  const normalized = value.trim();
  const match = normalized.match(/^(\d{1,2})(?:[.:](\d{2}))?(?:\s+(.+))?$/);
  if (!match) return null;
  return normalizeClock(
    Number(match[1]),
    Number(match[2] ?? 0),
    match[3] ?? normalized,
    match[2] ? "explicit" : "bare",
  );
}

function containsWord(text: string, word: string) {
  return new RegExp(`(^|[^${RU_CHARS}a-z])${escapeRegex(word)}($|[^${RU_CHARS}a-z])`, "i").test(text);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
