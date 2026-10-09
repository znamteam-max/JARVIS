import { DateTime } from "luxon";

import { formatRuWeekdayDateTime } from "@/domain/dateTime";
import { parseRussianDateTime, parseRussianTimeRange } from "@/services/russianDateTime";

const EXPLICIT_DEADLINE_MARKER =
  /(?:^|[^\p{L}])(?:дедлайн|deadline|срок|к\s+дедлайну|сдать|успеть|надо|нужно|край)(?=$|[^\p{L}])/iu;
const RELATIVE_DEADLINE =
  /(?:сегодня|завтра|послезавтра|понедельник|понедельника|понедельнику|вторник|вторника|вторнику|среда|среду|среды|четверг|четверга|четвергу|пятница|пятницу|пятницы|суббота|субботу|субботы|воскресенье|воскресенья)[^,;]*до\s+\d{1,2}(?:[.:]\d{2})?/i;
const DATE_DEADLINE =
  /до\s+\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?(?:\s+(?:в\s+)?)?\d{1,2}(?:[.:]\d{2})?/i;
const WEEKDAY_DEADLINE =
  /до\s+(?:понедельника|вторника|среды|четверга|пятницы|субботы|воскресенья)\s+(?:в\s+)?\d{1,2}(?:[.:]\d{2})?/i;
const END_OF_DAY_DEADLINE = /(?:сегодня|завтра)\s+до\s+конца\s+дня/i;

export type DeadlineSemantics = {
  dueLocal: DateTime;
  scheduledStartLocal: DateTime | null;
  scheduledEndLocal: DateTime | null;
  title: string | null;
  deadlineOnly: boolean;
};

export function parseDeadlineSemantics(params: {
  text: string;
  timezone: string;
  now?: Date;
  baseDate?: Date | null;
}): DeadlineSemantics | null {
  const text = params.text.trim();
  const explicitRange = parseRussianTimeRange(params);
  if (!hasDeadlineIntent(text, Boolean(explicitRange))) return null;
  const endOfDay = parseEndOfDayDeadline({
    text,
    timezone: params.timezone,
    now: params.now,
  });
  if (endOfDay) {
    return {
      dueLocal: endOfDay,
      scheduledStartLocal: null,
      scheduledEndLocal: null,
      title: extractDeadlineTitle(text),
      deadlineOnly: true,
    };
  }

  const deadlineSegment = extractDeadlineSegment(text, Boolean(explicitRange));
  if (!deadlineSegment) return null;
  const scheduleBase = explicitRange?.startLocal.toUTC().toJSDate() ?? params.baseDate ?? null;
  const parseable = toDeadlineDateTimeText(deadlineSegment);
  let parsed = parseRussianDateTime({
    text: parseable,
    timezone: params.timezone,
    now: params.now,
    baseDate: scheduleBase,
  });
  if (!parsed) return null;
  // "дедлайн до завтра" names a day, not 08:00: a deadline without a clock means end of that day.
  if (parsed.warnings.includes("time_missing_default_08_00")) {
    parsed = { ...parsed, local: parsed.local.set({ hour: 23, minute: 59 }) };
  }

  const nowLocal = DateTime.fromJSDate(params.now ?? new Date(), { zone: "utc" }).setZone(
    params.timezone,
  );
  if (
    parsed.source === "base_date" &&
    !scheduleBase &&
    parsed.local <= nowLocal &&
    !/(?:сегодня|завтра|послезавтра)/i.test(deadlineSegment)
  ) {
    parsed = { ...parsed, local: parsed.local.plus({ days: 1 }) };
  }

  return {
    dueLocal: parsed.local,
    scheduledStartLocal: explicitRange?.startLocal ?? null,
    scheduledEndLocal: explicitRange?.endLocal ?? null,
    title: extractDeadlineTitle(text),
    deadlineOnly: !explicitRange,
  };
}

export function hasDeadlineIntent(text: string, hasExplicitRange = false) {
  if (END_OF_DAY_DEADLINE.test(text)) return true;
  if (EXPLICIT_DEADLINE_MARKER.test(text)) return true;
  if (hasExplicitRange) return false;
  if (DATE_DEADLINE.test(text)) return true;
  if (WEEKDAY_DEADLINE.test(text)) return true;
  if (RELATIVE_DEADLINE.test(text) && !hasExplicitRange) return true;
  return false;
}

export function normalizeKnownProjectNames(title: string) {
  return title
    .replace(/(эфира?\s+)больше/giu, (_match, prefix: string) => `${prefix}Больше`)
    .replace(/централ\s+парк/giu, "Централ Парк")
    .replace(/чм[-\s]?26/giu, "ЧМ-26")
    .replace(/['«“"]\s*(норм\s*\/\s*стр[её]м)\s*['»”"]/giu, '"$1"')
    .trim();
}

export function formatDeadlineDateTime(value: Date, timezone: string, includeYear = false) {
  const formatted = formatRuWeekdayDateTime(value, timezone, { includeYear });
  return formatted.replace(/(\d{2}:\d{2})$/, "до $1");
}

export function buildDeadlineReminderFireAt(params: {
  dueAt: Date;
  timezone: string;
  preset: "soon" | "morning" | "2h" | "1h" | "30m";
  now?: Date;
}) {
  const due = DateTime.fromJSDate(params.dueAt, { zone: "utc" }).setZone(params.timezone);
  const now = DateTime.fromJSDate(params.now ?? new Date(), { zone: "utc" }).setZone(
    params.timezone,
  );
  const fire =
    params.preset === "soon"
      ? now.plus({ minutes: 10 })
      : params.preset === "morning"
        ? due.startOf("day").set({ hour: 9 })
        : due.minus({
            minutes: params.preset === "2h" ? 120 : params.preset === "1h" ? 60 : 30,
          });
  return fire > now && fire < due ? fire.toUTC().toJSDate() : null;
}

function extractDeadlineSegment(text: string, hasExplicitRange: boolean) {
  const explicitIndex = text.search(/(?:дедлайн|deadline|срок|к\s+дедлайну)/i);
  if (explicitIndex >= 0) return text.slice(explicitIndex);

  const verbMatch = text.match(/(?:сдать|успеть|надо|нужно|край)(?=$|[^\p{L}])[\s\S]*$/iu);
  if (verbMatch?.[0] && /до/i.test(verbMatch[0])) return verbMatch[0];

  if (!hasExplicitRange) {
    const relative = text.match(RELATIVE_DEADLINE);
    if (relative?.[0]) return relative[0];
  }
  const dated = text.match(DATE_DEADLINE);
  if (dated?.[0]) return dated[0];
  return text.match(WEEKDAY_DEADLINE)?.[0] ?? null;
}

function toDeadlineDateTimeText(segment: string) {
  let value = segment
    .replace(/(?:дедлайн|deadline|срок|к\s+дедлайну)[:,]?\s*/i, "")
    .replace(
      /^(?:сдать|успеть|надо|нужно|край).*?(?=(?:сегодня|завтра|послезавтра|в\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|до\s+(?:понедельника|вторника|среды|четверга|пятницы|субботы|воскресенья)|до\s+\d))/i,
      "",
    )
    .trim();

  value = value
    .replace(/до\s+(?=\d{1,2}(?:[.:]\d{2})?(?:$|[^\d]))/i, "в ")
    .replace(
      /до\s+(понедельника|вторника|среды|четверга|пятницы|субботы|воскресенья)\s+(?:в\s+)?(?=\d{1,2}(?:[.:]\d{2})?)/i,
      (_match, weekday: string) => `в ${normalizeDeadlineWeekdayCase(weekday)} `,
    )
    .replace(/до\s+(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)\s+(?=\d{1,2}(?:[.:]\d{2})?)/i, " $1 в ");

  if (
    /^\s*\d{1,2}(?:[.:]\d{2})?\s*$/.test(value) ||
    /^\s*(?:до\s+)?\d{1,2}(?:[.:]\d{2})?\s*$/.test(value)
  ) {
    value = `в ${value.replace(/^до\s+/i, "")}`;
  }
  return value;
}

function normalizeDeadlineWeekdayCase(weekday: string) {
  const weekdays: Record<string, string> = {
    понедельника: "понедельник",
    вторника: "вторник",
    среды: "среду",
    четверга: "четверг",
    пятницы: "пятницу",
    субботы: "субботу",
    воскресенья: "воскресенье",
  };
  return weekdays[weekday.toLowerCase()] ?? weekday;
}

function extractDeadlineTitle(text: string) {
  const endOfDay = text.match(END_OF_DAY_DEADLINE);
  if (endOfDay) {
    const after = text
      .slice((endOfDay.index ?? 0) + endOfDay[0].length)
      .replace(/^[,;:\s]*(?:нужно|надо|успеть|сделать)?\s*/i, "")
      .trim();
    if (after) {
      const title = /^(?:план|текст|обзор|задач)/i.test(after) ? `Сделать ${after}` : after;
      const normalized = normalizeKnownProjectNames(title.replace(/[.;,\s]+$/g, ""));
      return normalized.replace(/^./u, (character) => character.toLocaleUpperCase("ru"));
    }
  }
  let title = text;
  const explicitIndex = title.search(/\s*[,;]?\s*(?:дедлайн|deadline|срок|к\s+дедлайну)/i);
  if (explicitIndex >= 0) {
    title = title.slice(0, explicitIndex);
  } else {
    title = title
      .replace(
        /\s+(?:сегодня|завтра|послезавтра|в\s+(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье))\s+до\s+\d{1,2}(?:[.:]\d{2})?.*$/i,
        "",
      )
      .replace(
        /\s+до\s+(?:понедельника|вторника|среды|четверга|пятницы|субботы|воскресенья|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)\s*(?:в\s*)?\d{0,2}(?:[.:]\d{2})?.*$/i,
        "",
      );
  }
  title = title.replace(/\s*[,;]\s*$/, "").trim();
  return title ? normalizeKnownProjectNames(title) : null;
}

function parseEndOfDayDeadline(params: { text: string; timezone: string; now?: Date }) {
  const match = params.text.match(END_OF_DAY_DEADLINE);
  if (!match) return null;
  const nowLocal = DateTime.fromJSDate(params.now ?? new Date(), { zone: "utc" }).setZone(
    params.timezone,
  );
  return (/завтра/i.test(match[0]) ? nowLocal.plus({ days: 1 }) : nowLocal)
    .startOf("day")
    .set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
}
