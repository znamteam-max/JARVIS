import { getBot } from "@/bot/createBot";
import {
  getLatestStravaActivityStart,
  listActiveStravaConnections,
  markStravaActivitiesNotified,
  markStravaActivityIdsNotified,
  markStravaSynced,
  updateStravaTokens,
  upsertStravaActivities,
} from "@/db/queries/strava";
import type { StravaConnection } from "@/db/schema";
import {
  formatActivityCard,
  mapStravaActivity,
  selectActivitiesToAnnounce,
  type StravaActivityRow,
} from "@/domain/stravaActivity";
import { decryptSecret, encryptSecret } from "@/integrations/encryption";
import { fetchStravaActivities, refreshStravaToken } from "@/integrations/strava";
import { isStravaConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 3;

export async function syncStravaIfDue(now = new Date()) {
  if (!isStravaConfigured()) return { synced: false, reason: "not_configured" };
  let synced = 0;
  for (const entry of await listActiveStravaConnections()) {
    const last = entry.connection.lastSyncAt?.getTime() ?? 0;
    if (now.getTime() - last < SYNC_INTERVAL_MS) continue;
    try {
      await syncStravaConnection({
        connection: entry.connection,
        telegramUserId: entry.telegramUserId,
        now,
        announce: true,
      });
      synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Strava sync failed", { error: message });
      await markStravaSynced({ connectionId: entry.connection.id, at: now, error: message });
    }
  }
  return { synced: synced > 0, connections: synced };
}

export async function syncStravaConnection(params: {
  connection: StravaConnection;
  telegramUserId: bigint;
  now: Date;
  announce: boolean;
}) {
  const accessToken = await freshAccessToken(params.connection, params.now);
  const latest = await getLatestStravaActivityStart(params.connection.userId);
  const after = new Date(
    latest ? latest.getTime() - OVERLAP_MS : params.now.getTime() - INITIAL_HISTORY_MS,
  );
  const rows: StravaActivityRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchStravaActivities({ accessToken, after, page });
    rows.push(...batch.map(mapStravaActivity).filter((row) => row !== null));
    if (batch.length < 100) break;
  }
  const stored = await upsertStravaActivities(params.connection.userId, rows);
  await markStravaSynced({ connectionId: params.connection.id, at: params.now, error: null });

  let announced = 0;
  if (params.announce) {
    const fresh = selectActivitiesToAnnounce(stored, params.now).sort(
      (a, b) => a.startAt.getTime() - b.startAt.getTime(),
    );
    for (const activity of fresh) {
      await getBot().api.sendMessage(
        params.telegramUserId.toString(),
        `Новая тренировка в Strava:\n${formatActivityCard(activity)}`,
      );
      await markStravaActivityIdsNotified([activity.id], params.now);
      announced += 1;
    }
  }
  // Older history (or a silent import) must never be announced later in a burst.
  await markStravaActivitiesNotified(params.connection.userId, params.now);
  return { imported: rows.length, announced };
}

async function freshAccessToken(connection: StravaConnection, now: Date) {
  if (connection.expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return decryptSecret(connection.encryptedAccessToken);
  }
  const token = await refreshStravaToken(decryptSecret(connection.encryptedRefreshToken));
  await updateStravaTokens({
    connectionId: connection.id,
    encryptedAccessToken: encryptSecret(token.access_token),
    encryptedRefreshToken: encryptSecret(token.refresh_token),
    expiresAt: new Date(token.expires_at * 1000),
  });
  return token.access_token;
}
