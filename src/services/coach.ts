import { DateTime } from "luxon";

import { z } from "zod";

import { askClaudeJson, isAnthropicConfigured } from "@/ai/anthropicClient";
import { askClaudeRelay, isClaudeRelayConfigured } from "@/ai/claudeRelay";
import { getOpenAIClient } from "@/ai/openaiClient";
import { writeAudit } from "@/db/queries/audit";
import {
  countCoachQuestionsSince,
  getCoachProfile,
  getLatestCoachReview,
  insertCoachMessage,
  listActiveCoachMessages,
  listRideFilesSince,
  upsertRideFile,
} from "@/db/queries/coach";
import {
  applyMemoryChanges,
  listActiveMemories,
  listHealthRecords,
} from "@/db/queries/coachMemory";
import { listFitnessActivitiesSince, listWellnessDaysSince } from "@/db/queries/fitness";
import type { CoachMessage, User } from "@/db/schema";
import { activityWatts, withoutWatchDuplicates } from "@/domain/activityDedupe";
import { healthRecordsBlock, memoryBlock } from "@/domain/athleteMemory";
import { athleteNormsBlock, type IntervalsSportSettings } from "@/domain/athleteNorms";
import { chatModelLabel } from "@/domain/chatModelLabel";
import { recentLoadBlock } from "@/domain/recentLoad";
import { formatRideForCoach, type RideSummary } from "@/domain/rideAnalysis";
import { formatDistanceAndPace, sportLabel } from "@/domain/stravaActivity";
import { parseFitRide } from "@/integrations/fitFile";
import { getEnv } from "@/lib/env";
import { UserFacingError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { buildMiniAppSummary, type MiniAppSummary } from "@/services/miniappSummary";

const HISTORY_MESSAGES = 40;
const DAILY_QUESTION_LIMIT = 60;
const CLAUDE_TIMEOUT_MS = 90_000;
// Opus with effort "high" for an athlete; the coach bot's route allows 120 s.
const ATHLETE_CLAUDE_TIMEOUT_MS = 85_000;
const REVIEW_IN_CONTEXT_CHARS = 1800;
const DEFAULT_FTP = 300;
// Only for IF/TSS of an uploaded FIT file when an athlete has not set /ftp yet.
const DEFAULT_ATHLETE_FTP = 200;

export const COACH_INSTRUCTIONS = `Ты — личный тренер владельца приложения JARVIS по велоспорту и выносливости, и заодно помощник по его дню. Отвечай по-русски.

Стиль: прямо и по делу, без лишней похвалы и клише («не геройствуй» и т.п.), цифрами. Сравнивай тренировки числами. Если сравниваешь или даёшь план по дням — таблицей (не больше 5 колонок, экран телефона). Не повторяй одни и те же предостережения. Если данных нет или они ненадёжны — так и скажи, не изображай точность. Ответ компактный: для телефона.

Данные ниже:
- «Профиль и история» — главный документ от владельца: цели (180 км быстрее 5 часов), зоны, история, договорённости. Опирайся на него.
- «Заезды с мощностью» — посекундный разбор (Zwift через Intervals.icu и FIT-файлы Magene): ватты, интервалы, блоки по 10 минут, дрейф Pa:HR. IF/TSS посчитаны от FTP из настроек. Устройство Magene настроено на FTP 222, его собственные IF/TSS завышены — не используй их.
- «Все тренировки» (Intervals.icu): поездки Zwift — с мощностью; записи часов Garmin — только время и пульс. Записи часов, которые дублируют поездку Zwift по времени, уже убраны. Если в то же время есть и строка там, и заезд с мощностью — это одна и та же тренировка.
- Сон, HRV и пульс покоя, расписание дня и питание за сегодня.

- «Нагрузка последних дней» — тренировки по дням и сколько часов прошло с конца последней. Заезды с перерывом до 30 минут — это одна тренировка: считай их вместе (36 + 85 мин подряд — это одна двухчасовая).
- «Последний разбор» — что ты сам советовал после последней тренировки.

Учитывай восстановление (сон, HRV, пульс покоя), жару и охлаждение, болезнь, силовые, расписание и питание.
Прежде чем советовать, что делать сегодня или завтра, сверься с «Нагрузкой последних дней» и «Последним разбором». Не противоречь своему разбору и недавним ответам без новой причины; если меняешь совет — скажи, что изменилось. Длинную или тяжёлую тренировку на следующий день после длинной или тяжёлой ставь, только если так задумано в плане владельца.
У каждого сообщения переписки есть время — по нему понимай, что было сегодня, вчера, несколько часов назад.
Когда спрашивают, что делать сегодня — предложи одну конкретную тренировку: длительность, структура, ватты, каденс, охлаждение и питание до/во время/после — и в 1–2 строках почему. Если по данным лучше отдых — скажи прямо.
Не выдумывай тренировок, которых нет в данных. Каждое число в ответе (ватты, пульс, проценты, время в зонах) бери из данных ниже или прямо считай из них; если нужного числа в данных нет — не пиши его и не оценивай «на глаз». NP — это не максимум; максимумы и лучшие отрезки бери из строки «лучшие».`;

// Reviews and FIT uploads only answer; changes go through the JARVIS chat.
const ADVICE_ONLY_NOTE =
  "В этом ответе ты ничего не меняешь в расписании. Если советуешь что-то поставить или перенести — предложи владельцу попросить об этом в чате одной фразой.";

// The separate coach bot: a triathlete, read in Telegram, no planner behind it.
export const TRIATHLON_COACH_INSTRUCTIONS = `Ты — личный тренер по триатлону (плавание, велосипед, бег). Твоя спортсменка готовится к половинке Айронмена (70.3: 1,9 км плавания, 90 км велосипеда, 21,1 км бега) летом; старт, дата, цель и уровень — в её профиле. Отвечай по-русски, на «ты».

Стиль: прямо и по делу, цифрами, без лишней похвалы и клише. Сравнивай тренировки числами. Не повторяй одни и те же предостережения. Если данных нет или они ненадёжны — так и скажи, не изображай точность. Ответ читают в Telegram на телефоне: коротко; таблица — только если без неё никак, не больше 4 узких колонок.
Пиши как живой тренер: спокойно и тактично, без восторгов, без рассуждений про ИИ, ботов и технологии. Не больше одного вопроса в сообщении и ничего не навязывай: если она не отвечает на вопрос — не переспрашивай.

Данные ниже:
- «Профиль» — от самой спортсменки: старт и дата, цель по времени, опыт, объём, лучшие результаты, травмы, бассейн и открытая вода, сколько часов в неделю есть. Опирайся на него.
- «Нагрузка последних дней» — тренировки по дням и сколько часов прошло с конца последней. Заезды с перерывом до 30 минут — одна тренировка.
- «Последний разбор» — что ты сам советовал после последней тренировки.
- «Заезды с мощностью» — посекундный разбор велотренировок с мощностью (Zwift).
- «Все тренировки» (Intervals.icu: часы Garmin и Zwift): бег — темп на км и пульс; плавание — дистанция и темп на 100 м; велосипед — мощность (Zwift) или скорость и пульс. Если в то же время есть и запись часов, и заезд Zwift — это одна тренировка, дубли часов уже убраны.
- Сон, HRV и пульс покоя с часов Garmin.
- «Что она рассказала о себе» — её собственные слова о себе, сохранённые из прошлых разговоров. Помни их всегда.
- «Её нормы» — её обычный пульс и темп по её же тренировкам и зоны из Intervals.icu.
- «Анализы» — её результаты анализов с датами.

Как тренер:
- О себе говори в мужском роде («понял», «записал»).
- Пульс и темп оценивай относительно «Её норм» и того, что она рассказала о себе, а не по общим формулам. Если она сказала, что что-то для неё нормально, — это факт: не спорь и не пугай; обращай внимание только на заметные отклонения от её же нормы.
- Анализы учитывай в советах (для выносливости особенно важны гемоглобин, ферритин и железо), объясняй простыми словами, без диагнозов; при отклонениях советуй обсудить с врачом. Не пересказывай анализы без повода.
- Эту переписку и её анализы видит только она. Не предлагай чем-то делиться с другими, если она сама не попросит.
- Веди подготовку к старту по периодам (база → развитие → пик → подводка), считая недели до даты старта из профиля. Баланс трёх видов — по её слабым местам; силовая 1–2 раза в неделю; связки «велосипед → бег» ближе к сезону; в плавании — техника и открытая вода.
- Длинные тренировки наращивай постепенно (примерно до +10% в неделю); после 3 недель роста — разгрузочная неделя.
- Когда спрашивают, что делать сегодня, — одна конкретная тренировка: вид, длительность, структура, интенсивность (пульс, темп или ватты), еда и вода — и в 1–2 строках почему. Если по данным лучше отдых — скажи прямо.
- Прежде чем советовать, сверься с «Нагрузкой последних дней» и «Последним разбором»; не противоречь им без новой причины, а если меняешь совет — скажи, что изменилось. У каждого сообщения переписки есть время.
- Боль, травма, плохое самочувствие — не ставь диагнозов: советуй снизить нагрузку и обратиться к врачу.
- Если в профиле нет даты старта, уровня или доступных часов — не требуй заполнять анкету и не упоминай команды: узнавай это постепенно в разговоре, по одному вопросу, когда к слову. То, что она уже рассказала в переписке, считай известным.
Не выдумывай тренировок, которых нет в данных. Каждое число (темп, пульс, ватты, время) бери из данных или прямо считай из них; если нужного числа нет — не пиши его и не оценивай «на глаз».`;

export function isAthlete(user: Pick<User, "role">) {
  return user.role === "athlete";
}

// An athlete's FTP: their own /ftp, else what Intervals.icu has on the latest ride.
export function athleteFtp(
  settings: Record<string, unknown> | undefined,
  activities: Array<{ raw: unknown }> = [],
) {
  const own = Number(settings?.ftp);
  if (Number.isFinite(own) && own > 80) return own;
  for (const activity of [...activities].reverse()) {
    const ftp = Number((activity.raw as Record<string, unknown> | null)?.icu_ftp);
    if (Number.isFinite(ftp) && ftp > 80) return ftp;
  }
  return null;
}

export type CoachMessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  auto: boolean;
  // "Claude Opus 5.5", "GPT-4.1 (запасной)": who answered, shown under the bubble.
  model: string | null;
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
    model: row.role === "assistant" ? chatModelLabel(row.metadata) : null,
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
export async function buildCoachContext(
  user: User,
  now = new Date(),
  preparedSummary?: MiniAppSummary,
) {
  const tz = user.timezone;
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(tz).setLocale("ru");
  const label = (date: Date) =>
    DateTime.fromJSDate(date, { zone: "utc" })
      .setZone(tz)
      .setLocale("ru")
      .toFormat("ccc dd.LL HH:mm");
  const [profile, rides, activities, wellness, summary, review] = await Promise.all([
    getCoachProfile(user.id),
    listRideFilesSince(user.id, local.minus({ days: 42 }).toJSDate()),
    listFitnessActivitiesSince(user.id, local.minus({ days: 21 }).toJSDate()),
    listWellnessDaysSince(user.id, local.minus({ days: 14 }).toISODate() ?? ""),
    // An athlete of the coach bot has no planner: no schedule, no food log.
    preparedSummary ?? (isAthlete(user) ? null : buildMiniAppSummary(user, now)),
    getLatestCoachReview(user.id),
  ]);
  const settings = profile?.settings ?? {};

  const rideLines = rides.map((ride) =>
    formatRideForCoach(ride.summary as unknown as RideSummary, label(ride.startedAt)),
  );
  const workouts = withoutWatchDuplicates(activities).sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime(),
  );
  const reviewFresh =
    review && now.getTime() - review.createdAt.getTime() < 7 * 24 * 60 * 60 * 1000;
  const reviewBlock = reviewFresh
    ? [
        `## Последний разбор (${label(review.createdAt)}, ${chatModelLabel(review.metadata) ?? "тренер"})`,
        review.content.length > REVIEW_IN_CONTEXT_CHARS
          ? `${review.content.slice(0, REVIEW_IN_CONTEXT_CHARS)}…`
          : review.content,
      ].join("\n")
    : "## Последний разбор\nЗа неделю разборов не было.";
  const activityLines = workouts.map((activity) => {
    const raw = (activity.raw ?? {}) as Record<string, unknown>;
    const watts = activityWatts(activity);
    return [
      `${label(activity.startAt)} ${sportLabel(activity.sportType)} «${activity.name}»`,
      `${Math.round(activity.movingTimeS / 60)} мин`,
      formatDistanceAndPace(activity),
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
  if (!summary) {
    const ftp = athleteFtp(settings, workouts);
    const [memories, records, twoMonths] = await Promise.all([
      listActiveMemories(user.id),
      listHealthRecords(user.id),
      listFitnessActivitiesSince(user.id, local.minus({ days: 60 }).toJSDate()),
    ]);
    const intervals = settings.intervals as
      | { sports: IntervalsSportSettings[]; restingHr: number | null }
      | undefined;
    return [
      `Сейчас: ${local.toFormat("cccc, d MMMM yyyy, HH:mm")} (${tz}).`,
      `Настройки: FTP ${ftp ? `${ftp} Вт` : "не задан"}${settings.hrMax ? `, HRmax ${settings.hrMax}` : ""}${settings.weightKg ? `, вес ~${settings.weightKg} кг` : ""}.`,
      "",
      memoryBlock(memories),
      "",
      athleteNormsBlock({
        activities: withoutWatchDuplicates(twoMonths),
        restingHr: wellness
          .map((day) => day.restingHr)
          .filter((value): value is number => typeof value === "number" && value > 0),
        intervals: intervals ?? null,
      }),
      "",
      recentLoadBlock({ activities: workouts, now, timezone: tz }),
      "",
      reviewBlock,
      "",
      "## Профиль (от спортсменки)",
      profile?.profile ?? "Профиль ещё не заполнен.",
      "",
      healthRecordsBlock(records),
      "",
      "## Заезды с мощностью (посекундный разбор), 6 недель",
      rideLines.length ? rideLines.join("\n") : "Нет заездов с мощностью.",
      "",
      "## Все тренировки (Intervals.icu: часы Garmin и Zwift), 3 недели",
      activityLines.length ? activityLines.join("\n") : "Нет данных.",
      "",
      "## Сон и восстановление, 2 недели",
      wellnessLines.length ? wellnessLines.join("\n") : "Нет данных.",
    ].join("\n");
  }
  const planLines = summary.plan
    .filter((section) => /^(Сейчас|Сегодня|Завтра|Скоро|Просрочено|Не закрыто)/.test(section.title))
    .flatMap((section) => [`${section.title}:`, ...section.rows.map((row) => `- ${row.text}`)]);
  const food = summary.budget;

  return [
    `Сейчас: ${local.toFormat("cccc, d MMMM yyyy, HH:mm")} (${tz}).`,
    `Настройки: FTP ${coachFtp(settings)} Вт${settings.hrMax ? `, HRmax ${settings.hrMax}` : ""}${settings.weightKg ? `, вес ~${settings.weightKg} кг` : ""}.`,
    "",
    recentLoadBlock({ activities: workouts, now, timezone: tz }),
    "",
    reviewBlock,
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

// The thread as the model reads it: each message with its local time and author, so
// "9 часов назад" and "вчера ты советовал отдых" are visible in the text itself.
export function conversationTranscript(
  history: Array<Pick<CoachMessage, "role" | "content" | "createdAt" | "metadata">>,
  timezone: string,
  assistantName: string,
  userName = "Владелец",
  closing = "Ответь на последнее сообщение.",
) {
  const lines = history.map((message) => {
    const when = DateTime.fromJSDate(message.createdAt ?? new Date(), { zone: "utc" })
      .setZone(timezone)
      .setLocale("ru")
      .toFormat("ccc dd.LL HH:mm");
    const model = message.role === "assistant" ? chatModelLabel(message.metadata) : null;
    const who =
      message.metadata?.auto === true
        ? "Система"
        : message.role === "assistant"
          ? `${assistantName}${model ? ` (${model})` : ""}`
          : userName;
    return `[${when}] ${who}: ${message.content}`;
  });
  return `Переписка (последние сообщения, время местное):\n\n${lines.join("\n\n")}\n\n${closing}`;
}

// The coach also returns what to keep in her long memory: new facts she told about herself,
// and facts she took back. One request, so memory costs no extra wait.
export const ATHLETE_MEMORY_RULES = `Ответ возвращай в JSON: reply — текст ответа ей; remember — новые устойчивые факты о ней из её последних сообщений: здоровье и ограничения, её нормы и ощущения (например «утренний пульс у неё обычно выше среднего, и это её норма»), цели и старты, расписание и быт, что ей нравится или не нравится в тренировках. Коротко, от третьего лица, одна мысль — один пункт, не больше 10 за раз. Не повторяй то, что уже есть в «Что она рассказала о себе». Не сохраняй разовые события и цифры тренировок — они и так в данных. forget — текст пунктов из «Что она рассказала о себе» (без дефиса в начале), которые она опровергла или которые устарели. Если менять нечего — пустые списки.`;

const ATHLETE_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "remember", "forget"],
  properties: {
    reply: { type: "string" },
    remember: { type: "array", items: { type: "string" } },
    forget: { type: "array", items: { type: "string" } },
  },
};

const athleteAnswerSchema = z.object({
  reply: z.string(),
  // A long list is cut, never a reason to lose the answer itself.
  remember: z
    .array(z.string())
    .catch([])
    .transform((facts) => facts.slice(0, 10)),
  forget: z
    .array(z.string())
    .catch([])
    .transform((facts) => facts.slice(0, 20)),
});

async function answerAthleteWithClaude(params: {
  user: User;
  context: string;
  transcript: string;
  metadata?: Record<string, unknown>;
}) {
  const { data, model } = await askClaudeJson<unknown>({
    system: [
      { text: `${TRIATHLON_COACH_INSTRUCTIONS}\n\n${ATHLETE_MEMORY_RULES}`, cache: true },
      { text: params.context },
    ],
    content: params.transcript,
    schema: ATHLETE_ANSWER_SCHEMA,
    effort: "medium",
    timeoutMs: ATHLETE_CLAUDE_TIMEOUT_MS,
  });
  const answer = athleteAnswerSchema.parse(data);
  const text = answer.reply.trim();
  if (!text) throw new Error("Coach returned an empty answer");
  await applyMemoryChanges({
    userId: params.user.id,
    remember: answer.remember,
    forget: answer.forget,
  }).catch((error) =>
    logger.warn("Coach memory update failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  await insertCoachMessage({
    userId: params.user.id,
    role: "assistant",
    content: text,
    metadata: {
      ...params.metadata,
      engine: "anthropic",
      model,
      remembered: answer.remember.length,
    },
  });
  return text;
}

// Claude (owner's subscription, via the Cloudflare relay) answers first; OpenAI steps in
// when the relay is not configured or fails, so the chat is never silent.
export async function generateCoachReply(
  user: User,
  now: Date,
  extraInstruction?: string,
  options: {
    engine?: "auto" | "openai";
    claudeModel?: string;
    metadata?: Record<string, unknown>;
  } = {},
) {
  const athlete = isAthlete(user);
  const history = await listActiveCoachMessages(user.id, HISTORY_MESSAGES);
  const context = await buildCoachContext(user, now);
  const instructions = [
    athlete ? TRIATHLON_COACH_INSTRUCTIONS : COACH_INSTRUCTIONS,
    options.engine === "openai" || athlete ? null : ADVICE_ONLY_NOTE,
    extraInstruction,
    `# Данные\n${context}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const transcript = conversationTranscript(
    history,
    user.timezone,
    "Тренер",
    athlete ? "Спортсменка" : "Владелец",
  );
  // Athletes: Claude Opus by their own API key, with long memory. When it fails the answer
  // fails too: no quiet switch to a weaker model (the owner asked for "Opus always").
  if (athlete && isAnthropicConfigured()) {
    return answerAthleteWithClaude({
      user,
      context: [extraInstruction, `# Данные\n${context}`].filter(Boolean).join("\n\n"),
      transcript,
      metadata: options.metadata,
    });
  }
  // The owner's Max subscription is the owner's alone: athletes never go through the relay.
  if (!athlete && options.engine !== "openai" && isClaudeRelayConfigured()) {
    try {
      const answer = await askClaudeRelay({
        system: instructions,
        prompt: transcript,
        model: options.claudeModel ?? getEnv().CLAUDE_CHAT_MODEL,
        effort: "high",
        timeoutMs: CLAUDE_TIMEOUT_MS,
      });
      const text = answer.result?.trim();
      if (text) {
        await insertCoachMessage({
          userId: user.id,
          role: "assistant",
          content: text,
          metadata: { ...options.metadata, engine: "claude", model: answer.model },
        });
        return text;
      }
    } catch (error) {
      logger.warn("Coach via Claude failed, using OpenAI", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const ask = (model: string) =>
    getOpenAIClient().responses.create({
      model,
      instructions,
      input: transcript,
      max_output_tokens: 2000,
    });

  const primary = athlete
    ? (getEnv().ATHLETE_COACH_MODEL ?? getEnv().COACH_MODEL)
    : getEnv().COACH_MODEL;
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
    // With the relay set up, OpenAI answering means Claude was down: the bubble says so.
    metadata: {
      ...options.metadata,
      engine: "openai",
      model: response.model ?? model,
      fallback: !athlete && isClaudeRelayConfigured(),
    },
  });
  return text;
}

export async function guardCoachDailyLimit(user: User, now: Date) {
  const dayStart = DateTime.fromJSDate(now, { zone: "utc" }).setZone(user.timezone).startOf("day");
  const asked = await countCoachQuestionsSince(user.id, dayStart.toUTC().toJSDate());
  if (asked >= DAILY_QUESTION_LIMIT) {
    throw new UserFacingError("На сегодня лимит вопросов тренеру исчерпан. Продолжим завтра.");
  }
}

export async function askCoach(params: { user: User; message: string; now?: Date }) {
  const now = params.now ?? new Date();
  await guardCoachDailyLimit(params.user, now);
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
  await guardCoachDailyLimit(params.user, now);
  const profile = await getCoachProfile(params.user.id);
  const ftp = isAthlete(params.user)
    ? (athleteFtp(profile?.settings) ?? DEFAULT_ATHLETE_FTP)
    : coachFtp(profile?.settings);
  const summary = parseFitRide(params.bytes, { ftp });
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
