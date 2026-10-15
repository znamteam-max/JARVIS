import { NextResponse } from "next/server";

import { getBot } from "@/bot/createBot";
import { listStravaActivitiesSince, upsertStravaConnection } from "@/db/queries/strava";
import { getUserByTelegramId } from "@/db/queries/users";
import { formatWeekSummary } from "@/domain/stravaActivity";
import { encryptSecret } from "@/integrations/encryption";
import { exchangeStravaCode, readStravaState } from "@/integrations/strava";
import { logger } from "@/lib/logger";
import { syncStravaConnection } from "@/services/stravaSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error"))
    return page("Доступ к Strava не выдан. Можно закрыть вкладку.");
  const parsed = state ? readStravaState(state) : null;
  if (!code || !parsed) return page("Ссылка устарела. Попроси у бота новую командой /strava.", 400);
  const scope = url.searchParams.get("scope") ?? "";
  if (!/activity:read/.test(scope)) {
    return page("Без доступа к тренировкам подключение бесполезно. Повтори и оставь галочки.", 400);
  }

  try {
    const user = await getUserByTelegramId(parsed.telegramUserId);
    if (!user) throw new Error("Owner user not found for Strava state");
    const token = await exchangeStravaCode(code);
    if (!token.athlete?.id) throw new Error("Strava did not return the athlete");
    const athleteName =
      [token.athlete.firstname, token.athlete.lastname].filter(Boolean).join(" ") || null;
    const connection = await upsertStravaConnection({
      userId: user.id,
      athleteId: BigInt(token.athlete.id),
      athleteName,
      encryptedAccessToken: encryptSecret(token.access_token),
      encryptedRefreshToken: encryptSecret(token.refresh_token),
      expiresAt: new Date(token.expires_at * 1000),
      scope,
    });
    if (!connection) throw new Error("Strava connection was not saved");

    const now = new Date();
    const result = await syncStravaConnection({
      connection,
      telegramUserId: user.telegramUserId,
      now,
      announce: false,
    });
    const week = await listStravaActivitiesSince(
      user.id,
      new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    );
    await getBot().api.sendMessage(
      user.telegramUserId.toString(),
      [
        `✅ Strava подключена${athleteName ? `: ${athleteName}` : ""}.`,
        `Загрузил тренировок за 30 дней: ${result.imported}. Новые буду присылать сами.`,
        "",
        formatWeekSummary({ activities: week, timezone: user.timezone, now }),
      ].join("\n"),
    );
    return page("Strava подключена. Можно закрыть вкладку и вернуться в Telegram.");
  } catch (error) {
    logger.warn("Strava OAuth callback failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return page("Не получилось подключить Strava. Попробуй ещё раз командой /strava.", 500);
  }
}

function page(message: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="font-family:sans-serif;padding:24px"><h2>${message}</h2></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
