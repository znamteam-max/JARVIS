import { InlineKeyboard, type Bot } from "grammy";
import { DateTime } from "luxon";

import {
  getLatestStravaConnection,
  getStravaConnection,
  listStravaActivitiesSince,
} from "@/db/queries/strava";
import { formatWeekSummary } from "@/domain/stravaActivity";
import { createStravaConnectLink } from "@/integrations/strava";
import { isStravaConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { STRAVA_FORBIDDEN_TEXT, syncStravaConnection } from "@/services/stravaSync";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { replyAndRecord } from "./reply";

export function registerStravaHandlers(bot: Bot<BotContext>) {
  bot.command("strava", async (ctx) => renderStrava(ctx));
  bot.hears(/^(?:strava|страва)[.!?]?$/i, async (ctx) => renderStrava(ctx));

  bot.callbackQuery("strava:week", async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderStrava(ctx);
  });

  bot.callbackQuery("strava:sync", async (ctx) => {
    const owner = requireOwner(ctx);
    const connection = await getStravaConnection(owner.id);
    if (!connection) {
      await ctx.answerCallbackQuery("Strava не подключена");
      return;
    }
    await ctx.answerCallbackQuery("Обновляю…");
    try {
      const result = await syncStravaConnection({
        connection,
        telegramUserId: owner.telegramUserId,
        now: new Date(),
        announce: true,
      });
      if (!result.announced) await replyAndRecord(ctx, "Новых тренировок в Strava нет.");
    } catch (error) {
      logger.warn("Manual Strava sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await replyAndRecord(ctx, "Strava сейчас не ответила. Попробуй чуть позже.");
    }
  });
}

async function renderStrava(ctx: BotContext) {
  const owner = requireOwner(ctx);
  if (!isStravaConfigured()) {
    await replyAndRecord(
      ctx,
      "Подключение Strava ещё не настроено на сервере: нужны ключи приложения Strava API.",
    );
    return;
  }
  const connection = await getStravaConnection(owner.id);
  if (!connection) {
    const previous = await getLatestStravaConnection(owner.id);
    await replyAndRecord(
      ctx,
      previous?.status === "forbidden"
        ? `${STRAVA_FORBIDDEN_TEXT}\n\nКнопка ниже — подключить заново после оформления подписки.`
        : "Strava не подключена. Нажми кнопку, разреши доступ к тренировкам — и я начну их собирать. Ссылка действует 30 минут.",
      {
        reply_markup: new InlineKeyboard().url(
          "🔗 Подключить Strava",
          createStravaConnectLink(owner.telegramUserId.toString()),
        ),
      },
    );
    return;
  }
  const now = new Date();
  const week = await listStravaActivitiesSince(
    owner.id,
    new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
  );
  const synced = connection.lastSyncAt
    ? DateTime.fromJSDate(connection.lastSyncAt, { zone: "utc" })
        .setZone(owner.timezone)
        .toFormat("dd.LL HH:mm")
    : "ещё не было";
  await replyAndRecord(
    ctx,
    [
      formatWeekSummary({ activities: week, timezone: owner.timezone, now }),
      "",
      `Strava: ${connection.athleteName ?? "подключена"} · обновлено ${synced}`,
    ].join("\n"),
    {
      reply_markup: new InlineKeyboard()
        .text("🔄 Обновить", "strava:sync")
        .text("📊 Неделя", "strava:week"),
    },
  );
}
