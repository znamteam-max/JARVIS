import type { Bot } from "grammy";
import { after } from "next/server";

import type { User } from "@/db/schema";
import { shadowJarvisDecision } from "@/services/jarvisAgent";

import { transcribeMediaWithUsage } from "@/ai/transcription";
import { recordMessageAttachment, markTelegramMessageProcessed } from "@/db/queries/messages";
import { UserFacingError } from "@/lib/errors";
import {
  downloadTelegramMedia,
  extractTelegramMedia,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES,
} from "@/integrations/telegramFiles";

import type { BotContext } from "./context";
import { requireOwner } from "./context";
import { handleJarvisTurn } from "@/agent/jarvisPipeline";
import { getEnv } from "@/lib/env";
import { handleIncomingUserMessage } from "./messagePipeline";
import { handlePendingPlanEditTurn } from "./planEditFlow";
import { replyAndRecord } from "./reply";
import { refreshDashboardAfterMutation } from "@/telegram/liveDashboard";
import { renderTaskViewTool } from "@/agent/jarvisTools";
import { renderReminderControlCenter } from "@/telegram/reminderControlCenter";
import { navigationKeyboard } from "./keyboards";
import { writeAudit } from "@/db/queries/audit";
import { renderCleanupPreview } from "@/services/cleanupPreview";
import { renderCompletedItemsView } from "@/services/completedItemsView";
import { updateIncomingConversationTranscript } from "@/services/conversation";

export function registerMessageHandlers(bot: Bot<BotContext>) {
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    if (await handleNavigationText(ctx, ctx.message.text)) return;
    await handleNaturalText(ctx, ctx.message.text);
  });

  bot.on("edited_message:text", async (ctx) => {
    if (ctx.editedMessage.text.startsWith("/")) return;
    await handleNaturalText(ctx, ctx.editedMessage.text);
  });

  bot.on(["message:voice", "message:audio", "message:video_note", "message:video"], async (ctx) => {
    const media = extractTelegramMedia(ctx);
    if (!media) return;
    const owner = requireOwner(ctx);
    let transcriptionCompleted = false;
    try {
      await writeAudit({
        userId: owner.id,
        action: "assistant.transcription_status",
        entityType: "telegram_message",
        entityId: ctx.dbMessageId,
        details: { status: "started", mediaType: media.mimeType ?? "unknown" },
      }).catch(() => undefined);
      if (media.fileSize && media.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
        throw new UserFacingError(
          "Файл больше 20 МБ. Для MVP поддерживаю только стандартный Bot API лимит.",
        );
      }

      if (ctx.chat?.id) await ctx.api.sendChatAction(ctx.chat.id, "typing");
      const bytes = await downloadTelegramMedia(bot, media);
      const transcription = await transcribeMediaWithUsage({
        bytes,
        filename: media.filename,
        mimeType: media.mimeType,
      });
      const transcript = transcription.text;

      if (ctx.dbMessageId) {
        await recordMessageAttachment({
          messageId: ctx.dbMessageId,
          telegramFileId: media.fileId,
          telegramFileUniqueId: media.fileUniqueId,
          mimeType: media.mimeType,
          fileSize: media.fileSize,
          durationSeconds: media.durationSeconds,
        });
        await markTelegramMessageProcessed(ctx.dbMessageId, transcript);
        await updateIncomingConversationTranscript({
          telegramMessageId: ctx.dbMessageId,
          transcript,
        });
      }
      await writeAudit({
        userId: owner.id,
        action: "assistant.openai_usage",
        entityType: "telegram_message",
        entityId: ctx.dbMessageId,
        details: {
          capability: "transcription",
          model: transcription.model,
          succeeded: true,
          inputTokens: transcription.inputTokens,
          outputTokens: transcription.outputTokens,
          totalTokens: transcription.totalTokens,
          durationSeconds: transcription.durationSeconds ?? media.durationSeconds ?? null,
        },
      }).catch(() => undefined);
      await writeAudit({
        userId: owner.id,
        action: "assistant.transcription_status",
        entityType: "telegram_message",
        entityId: ctx.dbMessageId,
        details: { status: "succeeded", mediaType: media.mimeType ?? "unknown" },
      }).catch(() => undefined);
      transcriptionCompleted = true;

      await handleNaturalLanguageTurn(ctx, transcript, owner.timezone);
    } catch (error) {
      if (!transcriptionCompleted) {
        await writeAudit({
          userId: owner.id,
          action: "assistant.transcription_status",
          entityType: "telegram_message",
          entityId: ctx.dbMessageId,
          details: {
            status: "failed",
            mediaType: media.mimeType ?? "unknown",
            errorType: error instanceof UserFacingError ? "user_facing" : "processing",
          },
        }).catch(() => undefined);
      }
      await replyAndRecord(ctx, toUserMessage(error));
    }
  });
}

async function handleNavigationText(ctx: BotContext, text: string) {
  const owner = requireOwner(ctx);
  if (text === "🏠 План") {
    if (ctx.chat?.id) {
      await refreshDashboardAfterMutation({
        userId: owner.id,
        chatId: ctx.chat.id,
        timezone: owner.timezone,
      });
    }
    return true;
  }
  if (text === "➕ Добавить") {
    await replyAndRecord(ctx, "Напиши или надиктуй новое дело, встречу или напоминание.");
    return true;
  }
  if (text === "✅ Задачи") {
    const result = await renderTaskViewTool({
      userId: owner.id,
      timezone: owner.timezone,
      sourceMessageId: ctx.dbMessageId,
    });
    await replyAndRecord(
      ctx,
      result.reply,
      result.replyMarkup ? { reply_markup: result.replyMarkup } : undefined,
    );
    return true;
  }
  if (text === "🔔 Напоминания") {
    const center = await renderReminderControlCenter({
      userId: owner.id,
      timezone: owner.timezone,
      scope: "active",
    });
    await replyAndRecord(ctx, center.text, { reply_markup: center.keyboard });
    return true;
  }
  if (text === "✅ Выполненные") {
    const view = await renderCompletedItemsView({ userId: owner.id, timezone: owner.timezone });
    await replyAndRecord(ctx, view.text, { reply_markup: view.keyboard });
    return true;
  }
  if (text === "🧹 Очистить") {
    if (!ctx.chat?.id) return true;
    const preview = await renderCleanupPreview({
      userId: owner.id,
      chatId: String(ctx.chat.id),
    });
    await replyAndRecord(ctx, preview.text, { reply_markup: preview.keyboard });
    return true;
  }
  if (text === "⚙️ Настройки") {
    await ctx.reply(`Часовой пояс: ${owner.timezone}\nДля смены: /settings Europe/Moscow`, {
      reply_markup: navigationKeyboard(),
    });
    return true;
  }
  return false;
}

async function handleNaturalText(ctx: BotContext, text: string) {
  const owner = requireOwner(ctx);
  scheduleJarvisShadow(owner, text);
  try {
    await handleNaturalLanguageTurn(ctx, text, owner.timezone);
    if (ctx.dbMessageId) await markTelegramMessageProcessed(ctx.dbMessageId);
  } catch (error) {
    await replyAndRecord(ctx, toUserMessage(error));
  }
}

async function handleNaturalLanguageTurn(ctx: BotContext, text: string, timezone: string) {
  if (await handlePendingPlanEditTurn(ctx, text)) return;
  if (getEnv().OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE || getEnv().JARVIS_MODE_ENABLED) {
    await handleJarvisTurn(ctx, text, timezone);
    return;
  }
  await handleIncomingUserMessage(ctx, text, timezone);
}

// Shadow week: JARVIS (Claude) decides on the same message after the response, its
// decision is only recorded (assistant.jarvis_shadow) to compare with the old bot.
function scheduleJarvisShadow(owner: User, text: string) {
  const run = () => shadowJarvisDecision(owner, text).catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

function toUserMessage(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof Error && /OPENAI_API_KEY/.test(error.message)) {
    return "Для этого действия нужен OPENAI_API_KEY в env.";
  }
  return "Не получилось обработать сообщение. Ошибку записал в лог без секретов.";
}
