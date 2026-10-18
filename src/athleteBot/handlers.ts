import { InputFile } from "grammy";

import { getAthleteConnection, saveAthleteIntervalsKey } from "@/db/queries/athletes";
import {
  archiveCoachConversation,
  getCoachProfile,
  insertCoachMessage,
  saveCoachProfile,
} from "@/db/queries/coach";
import { getUserById } from "@/db/queries/users";
import type { AthleteConnection, User } from "@/db/schema";
import { encryptSecret } from "@/integrations/encryption";
import { fetchIntervals, IntervalsApiError } from "@/integrations/intervals";
import { getEnv } from "@/lib/env";
import { UserFacingError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { generateCoachReply, guardCoachDailyLimit, uploadRideToCoach } from "@/services/coach";
import { buildCoachChatExport } from "@/services/coachExport";
import { syncIntervalsForUser } from "@/services/intervalsSync";

import { askOwnerForAthleteAccess, ATHLETE_WELCOME } from "./access";
import { athleteBotApi, keepTyping, sendAthleteMarkdown, sendAthleteText } from "./telegram";

const MAX_FIT_BYTES = 8 * 1024 * 1024;

type TelegramMessage = {
  message_id: number;
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
  document?: { file_id: string; file_name?: string; file_size?: number };
};

export type TelegramUpdate = { update_id: number; message?: TelegramMessage };

export const PROFILE_TEMPLATE = `Напиши /profile и дальше одним сообщением:
• какой старт и когда (например, Ironman 70.3 Казань, 20 июля 2027);
• цель по времени;
• опыт: с какого года в спорте, какие старты были;
• сколько сейчас тренируешься в неделю (часы, сколько раз плавание, вело, бег);
• лучшие результаты (5 км, 10 км, полумарафон, 1500 м в бассейне);
• травмы и ограничения;
• есть ли бассейн, станок для Zwift, где бегаешь;
• сколько часов в неделю готова тратить и в какие дни.`;

// "/intervals i123456 KEY" → { athleteId, apiKey }; anything else → null.
export function parseIntervalsCommand(text: string) {
  const match = /^\/intervals(?:@\w+)?\s+(i?\d{2,12})\s+([A-Za-z0-9_-]{8,128})\s*$/i.exec(
    text.trim(),
  );
  if (!match) return null;
  const athleteId = match[1].toLowerCase().startsWith("i")
    ? match[1].toLowerCase()
    : `i${match[1]}`;
  return { athleteId, apiKey: match[2] };
}

// Checks the key with Intervals.icu, stores it encrypted, removes the message with the
// key from the chat and imports the last month.
async function connectIntervals(user: User, message: TelegramMessage, text: string) {
  const chatId = message.chat.id;
  const parsed = parseIntervalsCommand(text);
  if (!parsed) {
    await sendAthleteText(
      chatId,
      "Пришли одной строкой: /intervals i123456 ключ\nAthlete ID и API Key — на intervals.icu в Settings, раздел Developer Settings.",
    );
    return;
  }
  await athleteBotApi()
    .deleteMessage(chatId, message.message_id)
    .catch(() => undefined);
  const today = new Date().toISOString().slice(0, 10);
  try {
    await fetchIntervals("activities", { oldest: today, newest: today }, parsed);
  } catch (error) {
    const status = error instanceof IntervalsApiError ? error.status : 0;
    await sendAthleteText(
      chatId,
      status === 401 || status === 403 || status === 404
        ? "Intervals.icu не принял этот ID и ключ. Проверь Athlete ID (вида i123456) и создай ключ заново в Settings → Developer Settings. Сообщение с ключом я удалил."
        : "Intervals.icu сейчас не ответил. Попробуй ещё раз через пару минут. Сообщение с ключом я удалил.",
    );
    return;
  }
  await saveAthleteIntervalsKey({
    userId: user.id,
    athleteId: parsed.athleteId,
    encryptedKey: encryptSecret(parsed.apiKey),
  });
  const result = await syncIntervalsForUser({
    user,
    now: new Date(),
    announce: false,
    credentials: parsed,
  }).catch(() => null);
  await sendAthleteText(
    chatId,
    result
      ? `✅ Intervals.icu подключён, сообщение с ключом удалено. Загрузил тренировок за месяц: ${result.imported}, дней сна и пульса: ${result.wellnessDays}.\nТеперь после каждой тренировки пришлю разбор — примерно через 15–30 минут после того, как она появится в Intervals.`
      : "✅ Ключ сохранён, сообщение удалено. Первая загрузка тренировок не прошла — попробую снова в течение 15 минут.",
  );
}

async function statusText(user: User, connection: AthleteConnection) {
  const profile = await getCoachProfile(user.id);
  return [
    connection.intervalsApiKey
      ? "✅ Intervals.icu подключён — тренировки, сон и пульс приходят сами."
      : "⬜ Intervals.icu не подключён — /intervals",
    profile?.profile?.trim()
      ? "✅ Профиль заполнен — посмотреть: /profile"
      : "⬜ Профиль не заполнен — /profile",
  ].join("\n");
}

async function answerQuestion(user: User, chatId: number, text: string) {
  const now = new Date();
  await guardCoachDailyLimit(user, now);
  await insertCoachMessage({ userId: user.id, role: "user", content: text });
  const stop = keepTyping(chatId);
  try {
    const reply = await generateCoachReply(user, now);
    stop();
    await sendAthleteMarkdown(chatId, reply);
  } finally {
    stop();
  }
}

async function reviewFitFile(user: User, message: TelegramMessage) {
  const document = message.document!;
  const chatId = message.chat.id;
  if (!/\.fit$/i.test(document.file_name ?? "") || (document.file_size ?? 0) > MAX_FIT_BYTES) {
    await sendAthleteText(chatId, "Пришли файл тренировки в формате .fit (до 8 МБ).");
    return;
  }
  const stop = keepTyping(chatId);
  try {
    const file = await athleteBotApi().getFile(document.file_id);
    const response = await fetch(
      `https://api.telegram.org/file/bot${getEnv().ATHLETE_BOT_TOKEN}/${file.file_path}`,
    );
    if (!response.ok) throw new Error(`telegram_file_${response.status}`);
    const messages = await uploadRideToCoach({
      user,
      bytes: new Uint8Array(await response.arrayBuffer()),
      fileName: document.file_name ?? null,
    });
    const review = [...messages].reverse().find((item) => item.role === "assistant");
    stop();
    if (review) await sendAthleteMarkdown(chatId, review.content);
  } finally {
    stop();
  }
}

async function handleApproved(user: User, connection: AthleteConnection, message: TelegramMessage) {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  const command = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase() ?? null;
  const rest = command ? text.replace(/^\/\S+\s*/, "").trim() : text;

  if (message.document) return reviewFitFile(user, message);
  if (!text) {
    await sendAthleteText(chatId, "Пока понимаю текст и файлы тренировок .fit.");
    return;
  }
  switch (command) {
    case "start":
    case "help":
      await sendAthleteText(chatId, `${await statusText(user, connection)}\n\n${ATHLETE_WELCOME}`, {
        link_preview_options: { is_disabled: true },
      });
      return;
    case "intervals":
      return connectIntervals(user, message, text);
    case "profile": {
      const current = await getCoachProfile(user.id);
      if (rest) {
        await saveCoachProfile({
          userId: user.id,
          profile: rest,
          settings: current?.settings ?? {},
        });
        await sendAthleteText(
          chatId,
          "✅ Профиль сохранён. Тренер будет опираться на него; обновить — снова /profile и новый текст целиком.",
        );
        return;
      }
      const profile = current?.profile?.trim();
      await sendAthleteText(
        chatId,
        profile ? `Твой профиль:\n\n${profile}\n\n${PROFILE_TEMPLATE}` : PROFILE_TEMPLATE,
      );
      return;
    }
    case "ftp": {
      const ftp = Number(rest.replace(",", "."));
      if (!Number.isFinite(ftp) || ftp < 80 || ftp > 500) {
        await sendAthleteText(chatId, "Напиши FTP в ваттах, например: /ftp 210");
        return;
      }
      const current = await getCoachProfile(user.id);
      await saveCoachProfile({
        userId: user.id,
        profile: current?.profile ?? "",
        settings: { ...(current?.settings ?? {}), ftp: Math.round(ftp) },
      });
      await sendAthleteText(chatId, `✅ FTP ${Math.round(ftp)} Вт сохранён.`);
      return;
    }
    case "new":
      await archiveCoachConversation(user.id);
      await sendAthleteText(
        chatId,
        "Начали новый разговор. Тренировки, профиль и последний разбор я помню.",
      );
      return;
    case "export": {
      const { fileName, text: history } = await buildCoachChatExport(user);
      await athleteBotApi().sendDocument(
        chatId.toString(),
        new InputFile(Buffer.from(history, "utf8"), fileName),
        { caption: "История переписки с тренером." },
      );
      return;
    }
    default:
      return answerQuestion(user, chatId, text);
  }
}

// One update of the coach bot. Only approved people get the coach; anyone else's first
// message becomes a request the owner answers in JARVIS.
export async function handleAthleteUpdate(update: TelegramUpdate) {
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat.type !== "private") return;
  const from = message.from;
  const connection = await getAthleteConnection(from.id);
  if (!connection || connection.status === "pending") {
    await askOwnerForAthleteAccess({
      id: from.id,
      username: from.username,
      firstName: from.first_name,
    });
    await sendAthleteText(
      message.chat.id,
      "Привет! Это личный тренер по триатлону. Отправил запрос на доступ — как только его подтвердят, я напишу.",
    );
    return;
  }
  if (connection.status !== "approved" || !connection.userId) {
    await sendAthleteText(message.chat.id, "Доступа к тренеру нет.");
    return;
  }
  const user = await getUserById(connection.userId);
  if (!user) return;
  try {
    await handleApproved(user, connection, message);
  } catch (error) {
    if (error instanceof UserFacingError) {
      await sendAthleteText(message.chat.id, error.message);
      return;
    }
    logger.warn("Coach bot message failed", {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await sendAthleteText(
      message.chat.id,
      "Не получилось ответить. Попробуй ещё раз через минуту.",
    ).catch(() => undefined);
  }
}
