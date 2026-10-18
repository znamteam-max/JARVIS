import type { Bot } from "grammy";

import { connectAthleteBot, decideAthleteAccess } from "@/athleteBot/access";
import { isAthleteBotConfigured } from "@/athleteBot/telegram";

import type { BotContext } from "./context";
import { requireOwner } from "./context";

// The separate coach bot is managed from here: who may use it, and its webhook.
export function registerAthleteHandlers(bot: Bot<BotContext>) {
  bot.callbackQuery(/^athlete:(approve|deny):(\d{3,20})$/, async (ctx) => {
    requireOwner(ctx);
    const result = await decideAthleteAccess({
      telegramUserId: ctx.match[2],
      decision: ctx.match[1] as "approve" | "deny",
    });
    if (result.outcome === "missing" || result.outcome === "owner") {
      await ctx.answerCallbackQuery("Этот запрос уже неактуален");
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery(result.outcome === "approved" ? "Доступ дан" : "Отказано");
    await ctx
      .editMessageText(
        result.outcome === "approved"
          ? `✅ ${result.name}: доступ к тренеру дан. Бот уже прислал инструкцию: подключить Intervals.icu и заполнить профиль.`
          : `Отказано: ${result.name}.`,
      )
      .catch(() => undefined);
  });

  bot.command("athletebot", async (ctx) => {
    requireOwner(ctx);
    if (!isAthleteBotConfigured()) {
      await ctx.reply(
        "Тренерский бот не настроен: в Vercel нет переменной ATHLETE_BOT_TOKEN (токен бота из @BotFather).",
      );
      return;
    }
    try {
      const result = await connectAthleteBot();
      await ctx.reply(
        `✅ @${result.username} подключён к JARVIS: сообщения идут сюда (${result.url}), меню команд обновлено.\nПусть человек напишет боту /start — вам придёт запрос с кнопкой «Дать доступ».`,
      );
    } catch (error) {
      await ctx.reply(
        `Не получилось подключить тренерского бота: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
