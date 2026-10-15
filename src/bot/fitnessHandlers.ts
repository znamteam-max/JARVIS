import { InlineKeyboard, type Bot } from "grammy";
import { DateTime } from "luxon";

import { listFitnessActivitiesSince, listWellnessDaysSince } from "@/db/queries/fitness";
import { formatWellnessSummary } from "@/domain/intervalsFitness";
import { formatWeekSummary } from "@/domain/stravaActivity";
import { isIntervalsConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";
import { syncIntervalsForUser } from "@/services/intervalsSync";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { replyAndRecord } from "./reply";

const NOT_CONFIGURED = "Тренировки ещё не подключены: нужен API-ключ Intervals.icu на сервере.";

export function registerFitnessHandlers(bot: Bot<BotContext>) {
  bot.command("workouts", async (ctx) => renderWorkouts(ctx));
  bot.hears(/^(?:тренировки|тренировки за неделю)[.!?]?$/i, async (ctx) => renderWorkouts(ctx));
  bot.command("sleep", async (ctx) => renderSleep(ctx));
  bot.hears(/^(?:сон|восстановление)[.!?]?$/i, async (ctx) => renderSleep(ctx));

  bot.callbackQuery("fitness:sleep", async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderSleep(ctx);
  });

  bot.callbackQuery("fitness:sync", async (ctx) => {
    if (!isIntervalsConfigured()) {
      await ctx.answerCallbackQuery("Не подключено");
      return;
    }
    await ctx.answerCallbackQuery("Обновляю…");
    try {
      await syncIntervalsForUser({ user: requireOwner(ctx), now: new Date(), announce: true });
      await renderWorkouts(ctx);
    } catch (error) {
      logger.warn("Manual Intervals sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await replyAndRecord(ctx, "Intervals.icu сейчас не ответил. Попробуй чуть позже.");
    }
  });
}

async function renderWorkouts(ctx: BotContext) {
  if (!isIntervalsConfigured()) {
    await replyAndRecord(ctx, NOT_CONFIGURED);
    return;
  }
  const owner = requireOwner(ctx);
  const now = new Date();
  const activities = await listFitnessActivitiesSince(
    owner.id,
    new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
  );
  const wellness = await listWellnessDaysSince(owner.id, weekAgoDay(now, owner.timezone));
  await replyAndRecord(
    ctx,
    [
      formatWeekSummary({ activities, timezone: owner.timezone, now }),
      "",
      formatWellnessSummary(wellness),
    ].join("\n"),
    {
      reply_markup: new InlineKeyboard()
        .text("🔄 Обновить", "fitness:sync")
        .text("😴 Сон", "fitness:sleep"),
    },
  );
}

async function renderSleep(ctx: BotContext) {
  if (!isIntervalsConfigured()) {
    await replyAndRecord(ctx, NOT_CONFIGURED);
    return;
  }
  const owner = requireOwner(ctx);
  const wellness = await listWellnessDaysSince(owner.id, weekAgoDay(new Date(), owner.timezone));
  await replyAndRecord(ctx, formatWellnessSummary(wellness));
}

function weekAgoDay(now: Date, timezone: string) {
  return (
    DateTime.fromJSDate(now, { zone: "utc" }).setZone(timezone).minus({ days: 7 }).toISODate() ?? ""
  );
}
