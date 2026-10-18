import { InlineKeyboard } from "grammy";
import { DateTime } from "luxon";

import { canUseOpenAI } from "@/ai/openaiClient";
import { getBot } from "@/bot/createBot";
import { sendAthleteMarkdown, isAthleteBotConfigured } from "@/athleteBot/telegram";
import { listConnectedAthletes } from "@/db/queries/athletes";
import {
  getCoachProfile,
  getLatestCoachReview,
  insertCoachMessage,
  upsertRideFile,
} from "@/db/queries/coach";
import { claimActivitiesForCoach, listActivitiesAwaitingCoach } from "@/db/queries/fitness";
import { getUserByTelegramId } from "@/db/queries/users";
import type { FitnessActivity, User } from "@/db/schema";
import {
  activityWatts,
  coachNotificationExcerpt,
  withoutWatchDuplicates,
} from "@/domain/activityDedupe";
import { analyseRide, samplesFromStreams } from "@/domain/rideAnalysis";
import { formatDistanceAndPace, sportLabel } from "@/domain/stravaActivity";
import { fetchIntervalsActivityStreams, type IntervalsCredentials } from "@/integrations/intervals";
import { getAllowedTelegramUserIds, getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { athleteFtp, coachFtp, generateCoachReply, isAthlete } from "@/services/coach";
import { athleteIntervalsCredentials } from "@/services/intervalsSync";

const LOOKBACK_MS = 36 * 60 * 60 * 1000;
// Back-to-back sessions (two Zwift workouts with a short break) are reviewed together:
// wait until nothing new has finished for a while.
const QUIET_AFTER_LAST_END_MS = 15 * 60 * 1000;

const AUTO_REVIEW_INSTRUCTION = `Сейчас — автоматический разбор тренировок, которые только что пришли (последнее сообщение с 🔔, его прислала система, а не владелец).
Первая строка — главный вывод одной фразой, без заголовка. Дальше: цифры (таблица, если отрезков или тренировок несколько), сравнение с похожими прошлыми тренировками, что получилось и что нет, и что это значит для завтра и для плана. Если тренировки шли подряд с коротким перерывом — разбирай их как одну сессию. Коротко.`;

// Someone who did not ask for an AI coach: greet briefly, be useful, ask one easy question.
export const FIRST_CONTACT_INSTRUCTION = `Это твоё первое сообщение спортсменке. Начни с одной короткой фразы-приветствия, без рассказа о себе, о боте и об ИИ. Потом коротко и по делу разбери эту тренировку. В конце — один спокойный вопрос о планах на ближайший год: какие старты хочется (выбран ли уже старт половинки Айронмена и его дата) и что для неё сейчас главное. Добавь, что ответить можно когда удобно, хоть одной строкой, — а разборы будут приходить и без этого. Если в переписке ты уже писал ей про эту тренировку — не здоровайся повторно и не повторяй сказанное: добавь только новое (цифры, сравнение с прошлыми тренировками) и задай этот вопрос.`;

function activityEnd(activity: FitnessActivity) {
  return activity.startAt.getTime() + Math.max(activity.elapsedTimeS, activity.movingTimeS) * 1000;
}

function describe(activity: FitnessActivity, timezone: string) {
  const raw = (activity.raw ?? {}) as Record<string, unknown>;
  const watts = activityWatts(activity);
  const when = DateTime.fromJSDate(activity.startAt, { zone: "utc" })
    .setZone(timezone)
    .setLocale("ru")
    .toFormat("ccc dd.LL HH:mm");
  return [
    `${when} ${sportLabel(activity.sportType)} «${activity.name}»`,
    `${Math.round(activity.movingTimeS / 60)} мин`,
    formatDistanceAndPace(activity),
    watts ? `avg ${watts} Вт, NP ${raw.icu_weighted_avg_watts ?? "?"}` : null,
    activity.averageHeartrate
      ? `пульс ${activity.averageHeartrate}/${activity.maxHeartrate}`
      : null,
    typeof raw.average_cadence === "number" ? `каденс ${Math.round(raw.average_cadence)}` : null,
    typeof raw.icu_training_load === "number" ? `нагрузка ${raw.icu_training_load}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

// Per-second power/HR from Intervals → the same ride summary as an uploaded FIT file.
async function storePowerDetails(
  user: User,
  activity: FitnessActivity,
  ftp: number,
  credentials?: IntervalsCredentials,
) {
  if (!activityWatts(activity)) return;
  try {
    const streams = await fetchIntervalsActivityStreams(activity.externalId, credentials);
    const summary = analyseRide(samplesFromStreams(activity.startAt, streams), { ftp });
    if (!summary) return;
    await upsertRideFile({
      userId: user.id,
      startedAt: activity.startAt,
      fileName: activity.name,
      source: "intervals",
      summary: summary as unknown as Record<string, unknown>,
    });
  } catch (error) {
    logger.warn("Coach could not load ride streams", {
      activityId: activity.externalId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function notifyOwner(user: User, text: string) {
  const appUrl = getEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  await getBot().api.sendMessage(user.telegramUserId.toString(), `🏋️ Тренер\n\n${text}`, {
    reply_markup: new InlineKeyboard().webApp("Открыть разбор", `${appUrl}/app?tab=coach`),
  });
}

// Runs after each scheduler tick: every new workout gets the coach's comment and a
// Telegram notification — the owner's in JARVIS, each athlete's in the coach bot.
// Older history is never reviewed retroactively.
export async function reviewNewWorkoutsIfDue(now = new Date()) {
  if (!canUseOpenAI()) return { reviewed: 0, reason: "no_openai" };
  const [ownerTelegramId] = [...getAllowedTelegramUserIds()];
  const owner = ownerTelegramId ? await getUserByTelegramId(ownerTelegramId) : null;
  const ownerResult = owner
    ? await reviewForUser({ user: owner, now, notify: (text) => notifyOwner(owner, text) })
    : { reviewed: 0, reason: "owner_unknown" };

  let athletesReviewed = 0;
  if (isAthleteBotConfigured()) {
    for (const { connection, user } of await listConnectedAthletes()) {
      try {
        const result = await reviewForUser({
          user,
          now,
          credentials: athleteIntervalsCredentials(connection),
          notify: (text) => sendAthleteMarkdown(user.telegramUserId, text),
        });
        athletesReviewed += result.reviewed;
      } catch (error) {
        logger.warn("Athlete workout review failed", {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { ...ownerResult, athletesReviewed };
}

async function reviewForUser(params: {
  user: User;
  now: Date;
  credentials?: IntervalsCredentials;
  notify: (text: string) => Promise<unknown>;
}) {
  const { user: owner, now, notify } = params;
  const pending = await listActivitiesAwaitingCoach(
    owner.id,
    new Date(now.getTime() - LOOKBACK_MS),
  );
  if (!pending.length) return { reviewed: 0 };
  const lastEnd = Math.max(...pending.map(activityEnd));
  if (now.getTime() - lastEnd < QUIET_AFTER_LAST_END_MS) {
    return { reviewed: 0, reason: "waiting_for_session_end" };
  }
  // Claimed first, so two overlapping scheduler ticks never review the same ride twice.
  const claimed = await claimActivitiesForCoach(
    pending.map((activity) => activity.id),
    now,
  );
  const activities = withoutWatchDuplicates(claimed).sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime(),
  );
  if (!activities.length) return { reviewed: 0, reason: "claimed_elsewhere" };

  const profile = await getCoachProfile(owner.id);
  // An athlete without a known FTP gets no IF/TSS: invented zones are worse than none.
  const ftp = isAthlete(owner)
    ? athleteFtp(profile?.settings, activities)
    : coachFtp(profile?.settings);
  if (ftp) {
    for (const activity of activities) {
      await storePowerDetails(owner, activity, ftp, params.credentials);
    }
  }

  const lines = activities.map((activity) => describe(activity, owner.timezone));
  // The athlete's first automatic review is also the introduction.
  const firstContact = isAthlete(owner) && !(await getLatestCoachReview(owner.id));
  await insertCoachMessage({
    userId: owner.id,
    role: "user",
    content: `🔔 Новые тренировки:\n${lines.join("\n")}`,
    metadata: { auto: true, activityIds: activities.map((activity) => activity.id) },
  });
  try {
    const review = await generateCoachReply(
      owner,
      now,
      firstContact
        ? `${AUTO_REVIEW_INSTRUCTION}\n\n${FIRST_CONTACT_INSTRUCTION}`
        : AUTO_REVIEW_INSTRUCTION,
      { claudeModel: getEnv().CLAUDE_REVIEW_MODEL },
    );
    // The owner reads the full review in the app; an athlete has only the bot chat.
    await notify(
      isAthlete(owner)
        ? firstContact
          ? review
          : `🏋️ **Разбор тренировки**\n\n${review}`
        : coachNotificationExcerpt(review),
    );
  } catch (error) {
    logger.warn("Automatic coach review failed", {
      userId: owner.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // The athlete still hears about the workout, just without the coach's comment.
    await notify(`Новые тренировки:\n${lines.join("\n")}`).catch(() => undefined);
  }
  return { reviewed: activities.length };
}
