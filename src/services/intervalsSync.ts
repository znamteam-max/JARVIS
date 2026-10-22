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
import { listConnectedAthletes } from "@/db/queries/athletes";
import { getUserByTelegramId } from "@/db/queries/users";
import type { AthleteConnection, User } from "@/db/schema";
import { mapIntervalsActivity, mapIntervalsWellness } from "@/domain/intervalsFitness";
import { formatActivityCard, selectActivitiesToAnnounce } from "@/domain/stravaActivity";
import { decryptSecret } from "@/integrations/encryption";
import { getCoachProfile, mergeCoachSettings } from "@/db/queries/coach";
import { parseIntervalsAthlete } from "@/domain/athleteNorms";
import {
  fetchIntervals,
  fetchIntervalsAthlete,
  type IntervalsCredentials,
} from "@/integrations/intervals";
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

// The coach bot's athletes, each with their own Intervals.icu key and sync clock.
export async function syncAthletesIntervalsIfDue(now = new Date()) {
  let synced = 0;
  for (const { connection, user } of await listConnectedAthletes()) {
    const key = `${SYNC_KEY}:${user.id}`;
    const state = await getIntegrationSyncState(key);
    if (now.getTime() - (state?.lastSyncAt?.getTime() ?? 0) < SYNC_INTERVAL_MS) continue;
    try {
      await syncIntervalsForUser({
        user,
        now,
        announce: false,
        credentials: athleteIntervalsCredentials(connection),
      });
      await setIntegrationSyncState(key, now, null);
      await refreshAthleteZonesIfStale(user.id, athleteIntervalsCredentials(connection), now);
      synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Athlete Intervals sync failed", { userId: user.id, error: message });
      await setIntegrationSyncState(key, now, message);
    }
  }
  return { athletes: synced };
}

// Her threshold HR, max HR and zones from Intervals.icu, refreshed once a day for the coach.
const ZONES_REFRESH_MS = 24 * 60 * 60 * 1000;

export async function refreshAthleteZonesIfStale(
  userId: string,
  credentials: IntervalsCredentials,
  now = new Date(),
) {
  const settings = (await getCoachProfile(userId))?.settings ?? {};
  const cached = settings.intervals as { fetchedAt?: string } | undefined;
  if (cached?.fetchedAt && now.getTime() - Date.parse(cached.fetchedAt) < ZONES_REFRESH_MS) return;
  try {
    const athlete = parseIntervalsAthlete(await fetchIntervalsAthlete(credentials));
    await mergeCoachSettings(userId, {
      intervals: { ...athlete, fetchedAt: now.toISOString() },
    });
  } catch (error) {
    logger.warn("Athlete zones refresh failed", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function athleteIntervalsCredentials(connection: AthleteConnection): IntervalsCredentials {
  if (!connection.intervalsAthleteId || !connection.intervalsApiKey) {
    throw new Error("intervals_not_connected");
  }
  return {
    athleteId: connection.intervalsAthleteId,
    apiKey: decryptSecret(connection.intervalsApiKey),
  };
}

export async function syncIntervalsForUser(params: {
  user: User;
  now: Date;
  announce: boolean;
  credentials?: IntervalsCredentials;
}) {
  const { user, now, credentials } = params;
  const local = DateTime.fromJSDate(now, { zone: "utc" }).setZone(user.timezone);
  const latest = await getLatestFitnessActivityStart(user.id, INTERVALS_SOURCE);
  const oldest = latest
    ? DateTime.fromJSDate(latest, { zone: "utc" }).setZone(user.timezone).minus({ days: 1 })
    : local.minus({ days: INITIAL_HISTORY_DAYS });
  const rawActivities = await fetchIntervals(
    "activities",
    { oldest: oldest.toISODate() ?? "", newest: local.toISODate() ?? "" },
    credentials,
  );
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

  const rawWellness = await fetchIntervals(
    "wellness",
    {
      oldest: local.minus({ days: WELLNESS_DAYS }).toISODate() ?? "",
      newest: local.toISODate() ?? "",
    },
    credentials,
  );
  const wellness = await upsertWellnessDays(
    user.id,
    INTERVALS_SOURCE,
    rawWellness.map(mapIntervalsWellness).filter((row) => row !== null),
  );
  return { imported: rows.length, announced, wellnessDays: wellness.length };
}
