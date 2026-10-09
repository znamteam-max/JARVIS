import { DateTime } from "luxon";

import {
  parseBeforeEventReminderSpecs,
  type BeforeEventReminderSpec,
} from "@/domain/beforeEventReminderParsing";
import { hasNegativeReminderIntent, hasPositiveReminderIntent } from "@/domain/reminderIntent";
import { sanitizePlannerTitle } from "@/domain/titleSanitizer";
import { parseRussianDateTime, parseRussianTimeRange } from "@/services/russianDateTime";

export type ScheduledCreationIntent = {
  intent: "scheduled_creation";
  kind: "event" | "training";
  title: string;
  timezone: string;
  startLocal: string;
  endLocal: string;
  reminders: BeforeEventReminderSpec[];
  remindersSuppressedByUser: boolean;
  warnings: string[];
};

export function parseScheduledCreationIntent(params: {
  text: string;
  timezone: string;
  now: Date;
}): ScheduledCreationIntent | null {
  if (hasExplicitTargetReference(params.text)) return null;
  const hasNegative = hasNegativeReminderIntent(params.text);
  const hasPositive = hasPositiveReminderIntent(params.text);
  const hasStandaloneEvent = looksLikeStandaloneScheduledEvent(params.text);
  if (!hasNegative && !hasPositive && !hasStandaloneEvent) return null;

  const title = extractScheduledTitle(params.text);
  if (!title || title.length < 2) return null;

  // Parse the event clock only from the event clause. Reminder text can contain words
  // such as "за два дня"; the generic Russian clock parser also understands "дня" as
  // a PM day-part marker, so feeding the whole sentence could turn 07:00 into 19:00.
  const scheduleText = stripReminderClauseForSchedule(params.text);
  const dateParams = { ...params, text: scheduleText };
  const range = parseRussianTimeRange(dateParams);
  const dateTime = range ? null : parseRussianDateTime(dateParams);
  const startLocal = range?.startLocal ?? dateTime?.local ?? null;
  if (!startLocal?.isValid) return null;
  let endLocal = range?.endLocal ?? startLocal.plus({ minutes: defaultDurationMinutes(title) });
  if (endLocal <= startLocal) endLocal = startLocal.plus({ minutes: defaultDurationMinutes(title) });

  const reminders = hasNegative
    ? []
    : parseBeforeEventReminderSpecs({
        text: params.text,
        eventStartLocal: startLocal,
        timezone: params.timezone,
        now: params.now,
        allowAbsoluteTimes: false,
      }).reminders;

  if (hasPositive && !reminders.length) return null;

  return {
    intent: "scheduled_creation",
    kind: inferScheduledKind(title),
    title,
    timezone: params.timezone,
    startLocal: startLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    endLocal: endLocal.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    reminders,
    remindersSuppressedByUser: hasNegative,
    warnings: [
      ...(dateTime?.warnings ?? []),
      ...(dateTime?.pastConfirmationRequired ? ["scheduled_time_in_past"] : []),
    ],
  };
}

export function looksLikeExplicitNewScheduledCreationText(text: string) {
  if (hasExplicitTargetReference(text)) return false;
  const reminderDriven = hasPositiveReminderIntent(text) || hasNegativeReminderIntent(text);
  if (!reminderDriven && !looksLikeStandaloneScheduledEvent(text)) return false;
  if (!hasExplicitClock(text)) return false;
  return extractScheduledTitle(text).length >= 2;
}

export function hasExplicitTargetReference(text: string) {
  const normalized = text.toLocaleLowerCase("ru").replace(/ё/g, "е");
  return /(?:к\s+(?:этому|нему|последнему|выбранному)|по\s+этому|добавь\s+к\s+(?:этому|нему|последнему|выбранному))/i.test(
    normalized,
  );
}

function looksLikeStandaloneScheduledEvent(text: string) {
  const normalized = text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  if (!hasExplicitClock(normalized)) return false;
  if (looksLikeManagementMutation(normalized)) return false;
  return /(?:^|\s)(?:созвон|встреча|эфир|прием|визит|тренировка|запись)(?:\s|$|[,.;:!?])/i.test(
    normalized,
  );
}

function looksLikeManagementMutation(text: string) {
  return /(?:^|\s)(?:перенеси|перенести|перенес(?:и|ли|ен)?|измени|изменить|сдвинь|сдвинуть|передвинь|передвинуть|отмени|отменить|удали|удалить)(?:\s|$|[,.;:!?])/i.test(
    text,
  );
}

function hasExplicitClock(text: string) {
  return /(?:^|\s)(?:в|во|к|на|с)\s*\d{1,2}(?:[.:]\d{2})?(?:\s|,|$)/i.test(text);
}

function stripReminderClauseForSchedule(text: string) {
  return text
    .split(/[,.;]\s*(?:напомн|напомин|уведомл|без\s+(?:напомин|уведом))/i)[0]
    .trim();
}

function extractScheduledTitle(text: string) {
  const main = stripReminderClauseForSchedule(text);
  const withoutSchedule = main
    .replace(/(?:^|\s)(?:сегодня|завтра|послезавтра)(?=\s|$|[,.;:!?])/gi, " ")
    .replace(
      /(?:^|\s)(?:в|во|на)\s+(?:понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье|воскресению|пн|вт|ср|чт|пт|сб|вс)(?=\s|$|[,.;:!?])/gi,
      " ",
    )
    .replace(
      /(?:^|\s)(?:с|from)\s+\d{1,2}(?:[.:]\d{2})?(?:\s+(?:утра|дня|вечера|ночи))?\s+(?:до|to)\s+\d{1,2}(?:[.:]\d{2})?(?:\s+(?:утра|дня|вечера|ночи))?(?=\s|$|[,.;:!?])/gi,
      " ",
    )
    // Clock with its preposition first: "в 11.00" must not be eaten as a date, leaving "в".
    .replace(/(?:^|\s)(?:в|во|к|на)\s+\d{1,2}[.:]\d{2}(?=\s|$|[,.;:!?])/gi, " ")
    .replace(
      /(?:^|\s)(?:на\s+)?\d{1,2}\s+(?:январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|августа?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья]|янв|февр?|мар|апр|июн|июл|авг|сент?|окт|нояб?|дек)\.?(?=\s|$|[,.;:!?])/gi,
      " ",
    )
    .replace(/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/g, " ")
    .replace(/(?:^|\s)(?:в|во|к|на)\s+\d{1,2}(?=\s|$|[,.;:!?])/gi, " ")
    .replace(/(?:^|\s)(?:в|во|к|на|с|до)\s*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sanitized = sanitizePlannerTitle(withoutSchedule);
  const cleaned = sanitized
    .replace(
      /^(?:в|во)\s+(?=(?:созвон|встреча|эфир|прием|приём|визит|тренировка|запись)(?:\s|$|[,.;:!?]))/i,
      "",
    )
    .trim();
  if (cleaned !== sanitized && cleaned) {
    return cleaned[0].toLocaleUpperCase("ru") + cleaned.slice(1);
  }
  return cleaned;
}

function inferScheduledKind(title: string): "event" | "training" {
  return /трениров|велосипед|z2|зал\b|бег\b/i.test(title) ? "training" : "event";
}

function defaultDurationMinutes(title: string) {
  if (/массаж|визит|прием|приём|созвон|эфир|запись|встреч|трениров/i.test(title)) return 60;
  return 60;
}

export function localIsoToDate(localIso: string, timezone: string) {
  const local = DateTime.fromISO(localIso, { zone: timezone });
  if (!local.isValid) throw new Error(`Invalid local ISO: ${localIso}`);
  return local.toUTC().toJSDate();
}
