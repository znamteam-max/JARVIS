import { createHash } from "node:crypto";

import { Api } from "grammy";

import { markdownToTelegramChunks, telegramHtmlToPlain } from "@/domain/telegramHtml";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

// The separate coach bot (ATHLETE_BOT_TOKEN): athletes talk to their coach here, apart
// from the owner's JARVIS bot.
let api: Api | null = null;

export function athleteBotToken() {
  const env = getEnv();
  return env.ATHLETE_BOT_TOKEN || env.ANFISAKRASOTKA_BOT_TOKEN || null;
}

export function isAthleteBotConfigured() {
  return Boolean(athleteBotToken());
}

export function athleteBotApi() {
  const token = athleteBotToken();
  if (!token) throw new Error("athlete_bot_not_configured");
  api ??= new Api(token);
  return api;
}

// Telegram echoes this in every webhook call; derived from the token, so no extra secret.
export function athleteWebhookSecret(token = athleteBotToken() ?? "") {
  return createHash("sha256").update(`jarvis-athlete-webhook:${token}`).digest("hex").slice(0, 64);
}

export function athleteWebhookUrl() {
  return `${getEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/telegram/athlete/webhook`;
}

// The coach's Markdown as Telegram messages; plain text if Telegram rejects the HTML.
export async function sendAthleteMarkdown(chatId: number | string | bigint, markdown: string) {
  for (const chunk of markdownToTelegramChunks(markdown)) {
    try {
      await athleteBotApi().sendMessage(chatId.toString(), chunk, { parse_mode: "HTML" });
    } catch (error) {
      logger.warn("Coach bot HTML message rejected, sending plain text", {
        error: error instanceof Error ? error.message : String(error),
      });
      await athleteBotApi().sendMessage(chatId.toString(), telegramHtmlToPlain(chunk));
    }
  }
}

export async function sendAthleteText(
  chatId: number | string | bigint,
  text: string,
  extra?: Parameters<Api["sendMessage"]>[2],
) {
  await athleteBotApi().sendMessage(chatId.toString(), text, extra);
}

// "печатает…" while the coach thinks; Telegram shows it for ~5 s, so it is repeated.
export function keepTyping(chatId: number | string | bigint) {
  const send = () =>
    athleteBotApi()
      .sendChatAction(chatId.toString(), "typing")
      .catch(() => undefined);
  void send();
  const timer = setInterval(send, 4500);
  return () => clearInterval(timer);
}
