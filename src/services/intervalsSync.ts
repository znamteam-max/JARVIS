import { DateTime } from "luxon";

import { canUseOpenAI } from "@/ai/openaiClient";
import { getBot } from "@/bot/createBot";
import {
  getIntegrationSyncState,
  getLatestFitnessActivityStart,
  markAllFitnessActivitiesNotified,
  markFitnessActivityIdsNotified,
  setIntegrationSyncState,
  upsertFitnessActivities,
  upsertWellnessDays,
} from "@/db/queries/fitness";
import { getUserByTelegramId } from "@/db/queries/users";
import type { User } from "@/db/schema";
import { mapIntervalsActivity, mapIntervalsWellness } from "@/domain/intervalsFitness";
import { formatActivityCard, selectActivitiesToAnnounce } from "@/domain/stravaActivity";
import { fetchIntervals } from "@/integrations/intervals";
import { getAllowedTelegramUserIds, isIntervalsConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";

export const INTERVALS_SOURCE = "intervals";
const SYNC_KEY = "intervals_icu";
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const INITIAL_HISTORY_DAYS = 30;
const WELLNESS_DAYS = 7;

export async function syncIntervalsIfDue(now = new Date()) {
  if (!isIntervalsConfigured()) return { synced: false, reason: "not_configured" };
  const state = await getIntegrationSyncState(SYNC_KEY);
  const last = state?.lastSyncAt?.getTime() ?? 0;
  if (now.getTime() - last < SYNC_INTERVAL_MS) return { synced: false, reason: "not_due" };
  const [ownerTelegramId] = [...getAllowedTelegramUserIds()];
  const user = ownerTelegramId ? await getUserByTelegramId(ownerTelegramId) : null;
  if (!user) return { synced: false, reason: "owner_unknown" };
  try {
    // The very first import is silent: a month of history is not "new" workouts. With
    // OpenAI configured the coach announces workouts itself (coachReviews).
    const result = await syncIntervalsForUser({
      user,
      now,
      announce: Boolean(state?.lastSyncAt) && !canUseOpenAI(),
    });
    await setIntegrationSyncState(SYNC_KEY, now, null);
    return { synced: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Intervals sync failed", { error: message });
    await setIntegrationSyncState(SYNC_KEY, now, message);
    return { synced: false, reason: "failed" };
  }
}

export async function syncIntervalsForUser(params: { user: User; now: Date; announce: boolean }) {
  const { user, now } = params;
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(user.timezone);
  const latest = await getLatestFitnessActivityStart(user.id, INTERVALS_SOURCE);
  const oldest = latest
    ? DateTime.fromJSDate(latest, { zone: "utc" }).setZone(user.timezone).minus({ days: 1 })
    : local.minus({ days: INITIAL_HISTORY_DAYS });
  const rawActivities = await fetchIntervals("activities", {
    oldest: oldest.toISODate() ?? "",
    newest: local.toISODate() ?? "",
  });
  const rows = rawActivities
    .map((raw) => mapIntervalsActivity(raw, user.timezone))
    .filter((row) => row !== null);
  const stored = await upsertFitnessActivities(user.id, INTERVALS_SOURCE, rows);

  let announced = 0;
  if (params.announce) {
    const fresh = selectActivitiesToAnnounce(stored, now).sort(
      (a, b) => a.startAt.getTime() - b.startAt.getTime(),
    );
    for (const activity of fresh) {
      await getBot().api.sendMessage(
        user.telegramUserId.toString(),
        `Новая тренировка:\n${formatActivityCard(activity)}`,
      );
      await markFitnessActivityIdsNotified([activity.id], now);
      announced += 1;
    }
  }
  await markAllFitnessActivitiesNotified(user.id, now);

  const rawWellness = await fetchIntervals("wellness", {
    oldest: local.minus({ days: WELLNESS_DAYS }).toISODate() ?? "",
    newest: local.toISODate() ?? "",
  });
  const wellness = await upsertWellnessDays(
    user.id,
    INTERVALS_SOURCE,
    rawWellness.map(mapIntervalsWellness).filter((row) => row !== null),
  );
  return { imported: rows.length, announced, wellnessDays: wellness.length };
}
