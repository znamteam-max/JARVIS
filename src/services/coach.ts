import { DateTime } from "luxon";

import { getOpenAIClient } from "@/ai/openaiClient";
import { writeAudit } from "@/db/queries/audit";
import {
  countCoachQuestionsSince,
  getCoachProfile,
  insertCoachMessage,
  listActiveCoachMessages,
  listRideFilesSince,
  upsertRideFile,
} from "@/db/queries/coach";
import { listFitnessActivitiesSince, listWellnessDaysSince } from "@/db/queries/fitness";
import type { User } from "@/db/schema";
import { activityWatts, withoutWatchDuplicates } from "@/domain/activityDedupe";
import { formatRideForCoach, type RideSummary } from "@/domain/rideAnalysis";
import { sportLabel } from "@/domain/stravaActivity";
import { parseFitRide } from "@/integrations/fitFile";
import { getEnv } from "@/lib/env";
import { UserFacingError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { buildMiniAppSummary } from "@/services/miniappSummary";

const HISTORY_MESSAGES = 16;
const DAILY_QUESTION_LIMIT = 60;
const DEFAULT_FTP = 300;

const COACH_INSTRUCTIONS = `Ты — личный тренер владельца приложения JARVIS по велоспорту и выносливости, и заодно помощник по его дню. Отвечай по-русски.

Стиль: прямо и по делу, без лишней похвалы и клише («не геройствуй» и т.п.), цифрами. Сравнивай тренировки числами. Если сравниваешь или даёшь план по дням — таблицей (не больше 5 колонок, экран телефона). Не повторяй одни и те же предостережения. Если данных нет или они ненадёжны — так и скажи, не изображай точность. Ответ компактный: для телефона.

Данные ниже:
- «Профиль и история» — главный документ от владельца: цели (180 км быстрее 5 часов), зоны, история, договорённости. Опирайся на него.
- «Заезды с мощностью» — посекундный разбор (Zwift через Intervals.icu и FIT-файлы Magene): ватты, интервалы, блоки по 10 минут, дрейф Pa:HR. IF/TSS посчитаны от FTP из настроек. Устройство Magene настроено на FTP 222, его собственные IF/TSS завышены — не используй их.
- «Все тренировки» (Intervals.icu): поездки Zwift — с мощностью; записи часов Garmin — только время и пульс. Записи часов, которые дублируют поездку Zwift по времени, уже убраны. Если в то же время есть и строка там, и заезд с мощностью — это одна и та же тренировка.
- Сон, HRV и пульс покоя, расписание дня и питание за сегодня.

Учитывай восстановление (сон, HRV, пульс покоя), жару и охлаждение, болезнь, силовые, расписание и питание.
Когда спрашивают, что делать сегодня — предложи одну конкретную тренировку: длительность, структура, ватты, каденс, охлаждение и питание до/во время/после — и в 1–2 строках почему. Если по данным лучше отдых — скажи прямо.
Не выдумывай тренировок, которых нет в данных. Каждое число в ответе (ватты, пульс, проценты, время в зонах) бери из данных ниже или прямо считай из них; если нужного числа в данных нет — не пиши его и не оценивай «на глаз». NP — это не максимум; максимумы и лучшие отрезки бери из строки «лучшие». Ты только советуешь: сам ничего не меняешь в расписании.`;

export type CoachMessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  auto: boolean;
};

function view(row: {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}) {
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    auto: row.metadata?.auto === true,
  } satisfies CoachMessageView;
}

export async function listCoachConversation(userId: string) {
  return (await listActiveCoachMessages(userId, 60)).map(view);
}

export function coachFtp(settings: Record<string, unknown> | undefined) {
  const ftp = Number(settings?.ftp);
  return Number.isFinite(ftp) && ftp > 100 ? ftp : DEFAULT_FTP;
}

// Everything the coach knows, as plain text: profile, power rides, watch data, recovery,
// today's schedule and food.
export async function buildCoachContext(user: User, now = new Date()) {
  const tz = user.timezone;
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(tz).setLocale("ru");
  const label = (date: Date) =>
    DateTime.fromJSDate(date, { zone: "utc" })
      .setZone(tz)
      .setLocale("ru")
      .toFormat("ccc dd.LL HH:mm");
  const [profile, rides, activities, wellness, summary] = await Promise.all([
    getCoachProfile(user.id),
    listRideFilesSince(user.id, local.minus({ days: 42 }).toJSDate()),
    listFitnessActivitiesSince(user.id, local.minus({ days: 21 }).toJSDate()),
    listWellnessDaysSince(user.id, local.minus({ days: 14 }).toISODate() ?? ""),
    buildMiniAppSummary(user, now),
  ]);
  const settings = profile?.settings ?? {};

  const rideLines = rides.map((ride) =>
    formatRideForCoach(ride.summary as unknown as RideSummary, label(ride.startedAt)),
  );
  const activityLines = withoutWatchDuplicates(activities)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .map((activity) => {
      const raw = (activity.raw ?? {}) as Record<string, unknown>;
      const watts = activityWatts(activity);
      return [
        `${label(activity.startAt)} ${sportLabel(activity.sportType)} «${activity.name}»`,
        `${Math.round(activity.movingTimeS / 60)} мин`,
        watts ? `avg ${watts} Вт, NP ${raw.icu_weighted_avg_watts ?? "?"}` : null,
        activity.averageHeartrate
          ? `пульс ${activity.averageHeartrate}/${activity.maxHeartrate}`
          : null,
        typeof raw.icu_training_load === "number" ? `нагрузка ${raw.icu_training_load}` : null,
        activity.calories ? `${activity.calories} ккал` : null,
        activity.source === "manual" ? "(добавлена вручную)" : null,
      ]
        .filter(Boolean)
        .join(", ");
    });
  const wellnessLines = [...wellness]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((day) =>
      [
        day.day,
        day.sleepSecs
          ? `сон ${Math.floor(day.sleepSecs / 3600)}:${String(Math.round((day.sleepSecs % 3600) / 60)).padStart(2, "0")}`
          : null,
        day.sleepScore ? `оценка сна ${day.sleepScore}` : null,
        day.hrv ? `HRV ${day.hrv}` : null,
        day.restingHr ? `пульс покоя ${day.restingHr}` : null,
        typeof (day.raw as Record<string, unknown>)?.weight === "number"
          ? `вес ${(day.raw as Record<string, unknown>).weight}`
          : null,
      ]
        .filter(Boolean)
        .join(", "),
    );
  const planLines = summary.plan
    .filter((section) => /^(Сейчас|Сегодня|Завтра|Скоро|Просрочено|Не закрыто)/.test(section.title))
    .flatMap((section) => [`${section.title}:`, ...section.rows.map((row) => `- ${row.text}`)]);
  const food = summary.budget;

  return [
    `Сейчас: ${local.toFormat("cccc, d MMMM yyyy, HH:mm")} (${tz}).`,
    `Настройки: FTP ${coachFtp(settings)} Вт${settings.hrMax ? `, HRmax ${settings.hrMax}` : ""}${settings.weightKg ? `, вес ~${settings.weightKg} кг` : ""}.`,
    "",
    "## Профиль и история (от владельца)",
    profile?.profile ?? "Профиль ещё не заполнен.",
    "",
    "## Заезды с мощностью (посекундный разбор), 6 недель",
    rideLines.length ? rideLines.join("\n") : "Нет загруженных файлов с мощностью.",
    "",
    "## Все тренировки (Intervals.icu: Zwift с мощностью, часы Garmin — только пульс), 3 недели",
    activityLines.length ? activityLines.join("\n") : "Нет данных.",
    "",
    "## Сон и восстановление, 2 недели",
    wellnessLines.length ? wellnessLines.join("\n") : "Нет данных.",
    "",
    "## Расписание",
    planLines.length ? planLines.join("\n") : "Ничего не запланировано.",
    "",
    `## Питание сегодня: съедено ${food.eaten} из ${food.target} ккал (Б ${summary.eaten.proteinG}, Ж ${summary.eaten.fatG}, У ${summary.eaten.carbsG}); цель ${summary.goals.calories} ккал.`,
  ].join("\n");
}

// Answers the latest message in the thread, stores the answer and returns its text.
export async function generateCoachReply(user: User, now: Date, extraInstruction?: string) {
  const history = await listActiveCoachMessages(user.id, HISTORY_MESSAGES);
  const context = await buildCoachContext(user, now);
  const instructions = [COACH_INSTRUCTIONS, extraInstruction, `# Данные\n${context}`]
    .filter(Boolean)
    .join("\n\n");
  const input = history.map((message) => ({
    role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: message.content,
  }));
  const ask = (model: string) =>
    getOpenAIClient().responses.create({ model, instructions, input, max_output_tokens: 2000 });

  const primary = getEnv().COACH_MODEL;
  let model = primary;
  let response;
  try {
    response = await ask(primary);
  } catch (error) {
    // An unavailable coach model must not leave the chat silent.
    const status = (error as { status?: number }).status;
    if (status !== 404 && status !== 400) throw error;
    model = getEnv().OPENAI_TEXT_MODEL;
    logger.warn("Coach model unavailable, falling back", { primary, fallback: model });
    response = await ask(model);
  }
  const text = response.output_text?.trim();
  if (!text) throw new Error("Coach returned an empty answer");
  const usage = response.usage;
  await writeAudit({
    userId: user.id,
    action: "assistant.openai_usage",
    entityType: "coach",
    details: {
      capability: "coach",
      model: response.model ?? model,
      succeeded: true,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
    },
  }).catch(() => undefined);
  await insertCoachMessage({
    userId: user.id,
    role: "assistant",
    content: text,
    metadata: { model: response.model ?? model },
  });
  return text;
}

async function guardDailyLimit(user: User, now: Date) {
  const dayStart = DateTime.fromJSDate(now, { zone: "utc" }).setZone(user.timezone).startOf("day");
  const asked = await countCoachQuestionsSince(user.id, dayStart.toUTC().toJSDate());
  if (asked >= DAILY_QUESTION_LIMIT) {
    throw new UserFacingError("На сегодня лимит вопросов тренеру исчерпан. Продолжим завтра.");
  }
}

export async function askCoach(params: { user: User; message: string; now?: Date }) {
  const now = params.now ?? new Date();
  await guardDailyLimit(params.user, now);
  await insertCoachMessage({ userId: params.user.id, role: "user", content: params.message });
  await generateCoachReply(params.user, now);
  return listCoachConversation(params.user.id);
}

// "📎" in the chat: a FIT export becomes a power summary the coach keeps, then a review.
export async function uploadRideToCoach(params: {
  user: User;
  bytes: Uint8Array;
  fileName: string | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  await guardDailyLimit(params.user, now);
  const profile = await getCoachProfile(params.user.id);
  const summary = parseFitRide(params.bytes, { ftp: coachFtp(profile?.settings) });
  const startedAt = new Date(summary.startedAt);
  await upsertRideFile({
    userId: params.user.id,
    startedAt,
    fileName: params.fileName,
    source: "upload",
    summary: summary as unknown as Record<string, unknown>,
  });
  const when = DateTime.fromJSDate(startedAt, { zone: "utc" })
    .setZone(params.user.timezone)
    .setLocale("ru")
    .toFormat("ccc d MMMM, HH:mm");
  await insertCoachMessage({
    userId: params.user.id,
    role: "user",
    content: `📎 Загрузил тренировку за ${when}${params.fileName ? ` (${params.fileName})` : ""}. Разбери её.`,
  });
  await generateCoachReply(params.user, now);
  return listCoachConversation(params.user.id);
}
