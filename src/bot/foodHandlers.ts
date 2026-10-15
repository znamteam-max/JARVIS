import { InlineKeyboard, type Bot } from "grammy";

import { estimateFoodFromImage, reviseFoodEstimate } from "@/ai/foodEstimation";
import { writeAudit } from "@/db/queries/audit";
import {
  deleteFoodEntry,
  findFoodEntryForCorrection,
  insertFoodEntry,
  listFoodEntriesForDay,
  requestFoodCorrection,
  setFoodEntryReplyMessage,
  toFoodEstimate,
  updateFoodEntryEstimate,
} from "@/db/queries/food";
import type { FoodEntry } from "@/db/schema";
import {
  applySimpleFoodCorrections,
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
const CORRECTION_WINDOW_MS = 15 * 60 * 1000;

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
      const card = await replyAndRecord(
        ctx,
        formatFoodEstimateReply({
          estimate: result.estimate,
          dayTotals: sumFoodMacros(day),
          dayCount: day.length,
        }),
        entry ? { reply_markup: foodCardKeyboard(entry.id) } : undefined,
      );
      if (entry) await setFoodEntryReplyMessage(entry.id, card.message_id);
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

  // A reply to a food card, or the next text after "✏️ Исправить", corrects that entry.
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return next();
    const owner = requireOwner(ctx);
    const entry = await findFoodEntryForCorrection({
      userId: owner.id,
      replyToMessageId: ctx.message.reply_to_message?.message_id ?? null,
      requestedSince: new Date(Date.now() - CORRECTION_WINDOW_MS),
    });
    if (!entry) return next();
    await applyFoodCorrection(ctx, entry, text);
  });

  bot.callbackQuery(/^food:edit:([0-9a-f-]{36})$/, async (ctx) => {
    const owner = requireOwner(ctx);
    const entry = await requestFoodCorrection({
      userId: owner.id,
      entryId: ctx.match[1],
      at: new Date(),
    });
    await ctx.answerCallbackQuery(entry ? undefined : "Запись уже удалена");
    if (!entry) return;
    const items = toFoodEstimate(entry)
      .items.map((item) => `${item.name}${item.grams ? ` ${item.grams} г` : ""}`)
      .join(", ");
    await replyAndRecord(
      ctx,
      [
        `Что поправить в «${entry.title}»? Сейчас: ${items}.`,
        "Напиши одним сообщением, например: «лаваш 50 г», «курицы 200 г», «убери овощи», «добавь соус 30 г» или «курицы было больше».",
      ].join("\n"),
    );
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

function foodCardKeyboard(entryId: string) {
  return new InlineKeyboard()
    .text("✏️ Исправить", `food:edit:${entryId}`)
    .text("🗑 Удалить", `food:delete:${entryId}`)
    .row()
    .text("🍽 За сегодня", "food:today");
}

async function applyFoodCorrection(ctx: BotContext, entry: FoodEntry, correction: string) {
  const owner = requireOwner(ctx);
  const current = toFoodEstimate(entry);
  try {
    const simple = applySimpleFoodCorrections(current, correction);
    let estimate = simple;
    if (!estimate) {
      if (ctx.chat?.id) await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const revised = await reviseFoodEstimate({ current, correction });
      await writeAudit({
        userId: owner.id,
        action: "assistant.openai_usage",
        entityType: "telegram_message",
        entityId: ctx.dbMessageId,
        details: {
          capability: "food_correction",
          model: revised.model,
          succeeded: true,
          inputTokens: revised.inputTokens,
          outputTokens: revised.outputTokens,
          totalTokens: revised.totalTokens,
        },
      }).catch(() => undefined);
      estimate = revised.estimate.isFood ? revised.estimate : null;
    }
    if (!estimate) {
      await replyAndRecord(ctx, "Не понял, что поправить. Напиши, например: «лаваш 50 г».");
      return;
    }
    const updated = await updateFoodEntryEstimate({
      userId: owner.id,
      entryId: entry.id,
      estimate,
      correction,
      at: new Date(),
    });
    if (!updated) return;
    const day = await listFoodEntriesForDay({
      userId: owner.id,
      timezone: owner.timezone,
      day: updated.eatenAt,
    });
    const card = await replyAndRecord(
      ctx,
      `✏️ Исправил.\n\n${formatFoodEstimateReply({
        estimate,
        dayTotals: sumFoodMacros(day),
        dayCount: day.length,
      })}`,
      { reply_markup: foodCardKeyboard(entry.id) },
    );
    await setFoodEntryReplyMessage(entry.id, card.message_id);
  } catch (error) {
    logger.warn("Food correction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await replyAndRecord(ctx, "Не получилось пересчитать. Попробуй ещё раз чуть позже.");
  }
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
