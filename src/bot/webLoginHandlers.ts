import { InlineKeyboard, type Bot } from "grammy";

import { decideWebLogin, formatWebSessionLine } from "@/services/webLogin";

import type { BotContext } from "./context";
import { requireOwner } from "./context";

// Buttons under the "🔐 Вход в приложение JARVIS" request sent by /api/auth/web-login.
export function registerWebLoginHandlers(bot: Bot<BotContext>) {
  bot.callbackQuery(/^weblogin:(approve|deny|revoke):([0-9a-f-]{36})$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const decision = ctx.match[1] as "approve" | "deny" | "revoke";
    const result = await decideWebLogin({ ownerId: owner.id, sessionId: ctx.match[2], decision });
    if (result.outcome === "missing" || result.outcome === "stale" || !result.session) {
      await ctx.answerCallbackQuery("Этот запрос уже неактуален");
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      return;
    }
    const line = formatWebSessionLine(result.session, owner.timezone);
    if (result.outcome === "approved") {
      await ctx.answerCallbackQuery("Вход разрешён");
      await ctx
        .editMessageText(
          `✅ Вход разрешён: ${line}\nНа этом устройстве приложение работает без Telegram.`,
          {
            reply_markup: new InlineKeyboard().text(
              "🚪 Выйти с этого устройства",
              `weblogin:revoke:${result.session.id}`,
            ),
          },
        )
        .catch(() => undefined);
      return;
    }
    await ctx.answerCallbackQuery(
      result.outcome === "denied" ? "Вход отклонён" : "Устройство отключено",
    );
    await ctx
      .editMessageText(
        result.outcome === "denied"
          ? `🚫 Вход отклонён: ${line}`
          : `🚪 Устройство отключено: ${line}`,
      )
      .catch(() => undefined);
  });
}
