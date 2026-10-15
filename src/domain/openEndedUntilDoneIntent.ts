import { createHash } from "node:crypto";

import { DateTime } from "luxon";

export type OpenEndedUntilDoneIntent = {
  matched: true;
  title: string;
  intervalMinutes: number;
  stopCondition: "until_done";
  startsAtMode: "now";
  endsAt: null;
  timezone: string;
  confidence: "high" | "medium";
  sourceOrder: "title_before_stop_condition" | "cadence_before_title" | "mixed";
  timeScope: "persistent" | "today";
  startsAtLocal: string;
  nextFireAtLocal: string;
  endsAtLocal: string | null;
  textHash: string;
  titleHash: string;
  titlePreviewSafe: string;
};

const REMINDER_INTENT_PATTERN =
  /(?:^|[\s,;:—-])(?:пожалуйста\s+)?(?:напоминай|напомни|напоминать|напоминание|пинай|пингуй|долби|тычь)(?:\s+(?:мне|меня))?(?=$|[\s,;:—-])/i;

const CADENCE_PATTERN =
  /(?:кажд(?:ый|ые)\s+час(?:а|ов)?|раз\s+в\s+час|ежечасно|кажд(?:ый|ые)\s+пол\s*часа|кажд(?:ый|ые)\s+полчаса|кажд(?:ый|ые)\s+\d{1,3}\s*(?:мин(?:ут[уы]?|\.?)?|час(?:а|ов)?))/i;

const UNTIL_DONE_PATTERN =
  /(?:(?:до\s+тех\s+пор,?\s*(?:пока|когда)?\s*)?(?:пока\s+)?(?:я\s+)?не\s+(?:отмечу\s+(?:как\s+)?(?:выполненн|сделанн)[а-яё]*|нажму\s+сделал|сдела(?:ю|ем|ешь|ет|ют)|выполн(?:ю|им|ишь|ит|ят)|отмеч(?:у|уся|усь|ешь|ет|ут)|закро(?:ю|ем|ешь|ет|ют)|подтверж(?:у|уся|усь|даю|даем))|до\s+момента,?\s+когда\s+(?:я\s+)?сдела(?:ю|ем|ешь|ет|ют))/i;

export function detectOpenEndedUntilDoneIntent(params: {
  text: string;
  timezone: string;
  now: Date;
}): OpenEndedUntilDoneIntent | null {
  const normalized = normalizeRu(params.text);
  const intervalMinutes = parseOpenEndedUntilDoneIntervalMinutes(normalized);
  const hasReminderIntent = REMINDER_INTENT_PATTERN.test(normalized);
  const cadenceMatch = normalized.match(CADENCE_PATTERN);
  const stopMatch = normalized.match(UNTIL_DONE_PATTERN);
  if (!intervalMinutes || !cadenceMatch || !stopMatch) return null;
  if (!hasReminderIntent) return null;
  if (hasExplicitStartClock(normalized)) return null;

  const title = extractOpenEndedUntilDoneTitle(params.text);
  if (!title) return null;

  const nowLocal = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  const firstReminder = nowLocal.plus({ minutes: 5 }).startOf("minute");
  const todayOnly = /(?:^|[\s,;:—-])сегодня(?=$|[\s,;:—-])|до\s+конца\s+дня/i.test(
    normalized,
  );
  const windowEnd = todayOnly
    ? nowLocal.set({ hour: 23, minute: 59, second: 0, millisecond: 0 })
    : null;
  if (windowEnd && firstReminder > windowEnd) return null;

  return {
    matched: true,
    title,
    intervalMinutes,
    stopCondition: "until_done",
    startsAtMode: "now",
    endsAt: null,
    timezone: params.timezone,
    confidence: title.length >= 3 ? "high" : "medium",
    sourceOrder: detectSourceOrder({
      normalized,
      title,
      cadenceIndex: cadenceMatch.index ?? -1,
      stopIndex: stopMatch.index ?? -1,
    }),
    timeScope: todayOnly ? "today" : "persistent",
    startsAtLocal: firstReminder.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    nextFireAtLocal: firstReminder.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    endsAtLocal: windowEnd?.toFormat("yyyy-MM-dd'T'HH:mm:ss") ?? null,
    textHash: shortHash(params.text),
    titleHash: shortHash(title),
    titlePreviewSafe: safeTitlePreview(title),
  };
}

export function parseOpenEndedUntilDoneIntervalMinutes(text: string) {
  const normalized = normalizeRu(text);
  if (/кажд(?:ый|ые)\s+пол\s*часа|кажд(?:ый|ые)\s+полчаса/i.test(normalized)) return 30;
  if (/кажд(?:ый|ые)\s+час(?:а|ов)?|раз\s+в\s+час|ежечасно/i.test(normalized)) return 60;
  const minutes = normalized.match(/кажд(?:ый|ые)\s+(\d{1,3})\s*мин(?:ут[уы]?|\.?)?/i);
  if (minutes?.[1]) {
    const value = Number(minutes[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const hours = normalized.match(/кажд(?:ый|ые)\s+(\d{1,2})\s*час(?:а|ов)?/i);
  if (hours?.[1]) {
    const value = Number(hours[1]);
    if (Number.isFinite(value) && value > 0) return value * 60;
  }
  return null;
}

export function extractOpenEndedUntilDoneTitle(text: string) {
  let title = text.replace(/\s+/g, " ").trim();
  title = title
    .replace(UNTIL_DONE_PATTERN, " ")
    .replace(CADENCE_PATTERN, " ")
    .replace(
      /(?:^|[\s,;:—-])(?:пожалуйста\s+)?(?:напоминай|напомни|напоминать|пинай|пингуй|долби|тычь)(?:\s+(?:мне|меня))?(?=$|[\s,;:—-])/gi,
      " ",
    )
    .replace(/(?:^|[\s,;:—-])напоминание(?=$|[\s,;:—-])/gi, " ")
    .replace(/(?:^|[\s,;:—-])(?:сегодня|до\s+конца\s+дня)(?=$|[\s,;:—-])/gi, " ")
    .replace(/^\s*(?:мне|меня)\s+/i, "")
    .replace(/\s*,(?:\s*,)+/g, ",")
    .replace(/^[\s:.,;!?—-]+/g, "")
    .replace(/[\s:.,;!?—-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return title ? title.replace(/^(\p{Ll})/u, (match) => match.toLocaleUpperCase("ru")) : null;
}

function detectSourceOrder(params: {
  normalized: string;
  title: string;
  cadenceIndex: number;
  stopIndex: number;
}): OpenEndedUntilDoneIntent["sourceOrder"] {
  const titleIndex = params.normalized.indexOf(normalizeRu(params.title));
  if (params.cadenceIndex >= 0 && titleIndex >= 0 && params.cadenceIndex < titleIndex) {
    return "cadence_before_title";
  }
  if (titleIndex >= 0 && params.stopIndex >= 0 && titleIndex < params.stopIndex) {
    return "title_before_stop_condition";
  }
  return "mixed";
}

function hasExplicitStartClock(text: string) {
  return (
    /(?:^|\s)(?:сегодня\s+|завтра\s+)?в\s+\d{1,2}(?:[.:]\d{2})?/i.test(text) ||
    /начиная\s+с\s+\d{1,2}(?:[.:]\d{2})?/i.test(text) ||
    /(?:^|\s)с\s+\d{1,2}(?:[.:]\d{2})?/i.test(text)
  );
}

function normalizeRu(value: string) {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeTitlePreview(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}
