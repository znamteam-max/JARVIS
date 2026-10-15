import { InlineKeyboard, type Bot } from "grammy";

import { estimateFoodFromImage } from "@/ai/foodEstimation";
import { writeAudit } from "@/db/queries/audit";
import { deleteFoodEntry, insertFoodEntry, listFoodEntriesForDay } from "@/db/queries/food";
import {
  formatFoodDaySummary,
  formatFoodEstimateReply,
  sumFoodMacros,
} from "@/domain/foodEstimate";
import { downloadTelegramMedia, TELEGRAM_DOWNLOAD_LIMIT_BYTES } from "@/integrations/telegramFiles";
import { UserFacingError } from "@/lib/errors";
import { logger } from "@/lib/logger";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { replyAndRecord } from "./reply";

const PHOTO_MIME_TYPE = "image/jpeg";

export function registerFoodHandlers(bot: Bot<BotContext>) {
  bot.on("message:photo", async (ctx) => {
    const owner = requireOwner(ctx);
    // Telegram lists sizes small to large; take the largest one the Bot API can download.
    const photo = [...ctx.message.photo]
      .reverse()
      .find((size) => !size.file_size || size.file_size <= TELEGRAM_DOWNLOAD_LIMIT_BYTES);
    if (!photo) {
      await replyAndRecord(ctx, "Фото слишком большое для Telegram-бота. Пришли его сжатым.");
      return;
    }
    const caption = ctx.message.caption?.trim() || null;
    try {
      if (ctx.chat?.id) await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const bytes = await downloadTelegramMedia(bot, {
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        fileSize: photo.file_size,
        mimeType: PHOTO_MIME_TYPE,
        filename: "food.jpg",
      });
      const result = await estimateFoodFromImage({ bytes, mimeType: PHOTO_MIME_TYPE, caption });
      await writeAudit({
        userId: owner.id,
        action: "assistant.openai_usage",
        entityType: "telegram_message",
        entityId: ctx.dbMessageId,
        details: {
          capability: "food_estimation",
          model: result.model,
          succeeded: true,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalTokens: result.totalTokens,
        },
      }).catch(() => undefined);

      const eatenAt = new Date(ctx.message.date * 1000);
      const entry = result.estimate.isFood
        ? await insertFoodEntry({
            userId: owner.id,
            sourceMessageId: ctx.dbMessageId ?? null,
            telegramFileId: photo.file_id,
            caption,
            eatenAt,
            estimate: result.estimate,
            model: result.model,
          })
        : null;
      const day = await listFoodEntriesForDay({
        userId: owner.id,
        timezone: owner.timezone,
        day: eatenAt,
      });
      await replyAndRecord(
        ctx,
        formatFoodEstimateReply({
          estimate: result.estimate,
          dayTotals: sumFoodMacros(day),
          dayCount: day.length,
        }),
        entry
          ? {
              reply_markup: new InlineKeyboard()
                .text("🗑 Удалить запись", `food:delete:${entry.id}`)
                .text("🍽 За сегодня", "food:today"),
            }
          : undefined,
      );
    } catch (error) {
      logger.warn("Food photo estimation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await writeAudit({
        userId: owner.id,
        action: "assistant.openai_usage",
        entityType: "telegram_message",
        entityId: ctx.dbMessageId,
        details: { capability: "food_estimation", succeeded: false },
      }).catch(() => undefined);
      await replyAndRecord(
        ctx,
        error instanceof UserFacingError
          ? error.message
          : "Не получилось посчитать калории по фото. Попробуй ещё раз чуть позже.",
      );
    }
  });

  bot.command("food", async (ctx) => {
    await replyAndRecord(ctx, await renderFoodToday(ctx));
  });

  bot.hears(/^(?:калории|еда)(?:\s+(?:сегодня|за\s+сегодня))?[.!?]?$/i, async (ctx) => {
    await replyAndRecord(ctx, await renderFoodToday(ctx));
  });

  bot.callbackQuery("food:today", async (ctx) => {
    await ctx.answerCallbackQuery();
    await replyAndRecord(ctx, await renderFoodToday(ctx));
  });

  bot.callbackQuery(/^food:delete:([0-9a-f-]{36})$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const deleted = await deleteFoodEntry({ userId: owner.id, entryId: ctx.match[1] });
    await ctx.answerCallbackQuery(deleted ? "Удалил запись" : "Запись уже удалена");
    if (deleted) {
      await ctx
        .editMessageText(`🗑 Удалил: ${deleted.title} (${deleted.calories} ккал).`)
        .catch(() => undefined);
      await replyAndRecord(ctx, await renderFoodToday(ctx));
    }
  });
}

async function renderFoodToday(ctx: BotContext) {
  const owner = requireOwner(ctx);
  const now = new Date();
  const entries = await listFoodEntriesForDay({
    userId: owner.id,
    timezone: owner.timezone,
    day: now,
  });
  return formatFoodDaySummary({ entries, timezone: owner.timezone, now });
}
