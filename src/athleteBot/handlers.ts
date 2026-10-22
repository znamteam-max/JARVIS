import { InputFile } from "grammy";

import {
  getAthleteConnection,
  listApprovedAthletes,
  saveAthleteIntervalsKey,
} from "@/db/queries/athletes";
import {
  archiveCoachConversation,
  getCoachProfile,
  insertCoachMessage,
  saveCoachProfile,
} from "@/db/queries/coach";
import {
  deleteHealthRecordAt,
  listActiveMemories,
  listHealthRecords,
  removeMemoryAt,
} from "@/db/queries/coachMemory";
import { getUserById } from "@/db/queries/users";
import { isAnthropicConfigured, isClaudeUnavailable } from "@/ai/anthropicClient";
import { getBot } from "@/bot/createBot";
import { formatTakenOn, healthRecordsList } from "@/domain/athleteMemory";
import {
  isSupportedHealthType,
  readHealthDocument,
  saveHealthDocument,
} from "@/services/healthDocuments";
import type { AthleteConnection, User } from "@/db/schema";
import { encryptSecret } from "@/integrations/encryption";
import { fetchIntervals, IntervalsApiError } from "@/integrations/intervals";
import { getAllowedTelegramUserIds } from "@/lib/env";
import { UserFacingError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { generateCoachReply, guardCoachDailyLimit, uploadRideToCoach } from "@/services/coach";
import { buildCoachChatExport } from "@/services/coachExport";
import { syncIntervalsForUser } from "@/services/intervalsSync";

import { askOwnerForAthleteAccess, ATHLETE_WELCOME } from "./access";
import {
  athleteBotApi,
  athleteBotToken,
  keepTyping,
  sendAthleteMarkdown,
  sendAthleteText,
} from "./telegram";

const MAX_FIT_BYTES = 8 * 1024 * 1024;
const MAX_HEALTH_BYTES = 15 * 1024 * 1024;
// Claude takes images up to 5 MB; Telegram's own photo compression stays far below.
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const OWNER_ALERT_EVERY_MS = 60 * 60 * 1000;
let lastOwnerAlertAt = 0;

// Errors of the coach bot without her data: a failed query's message carries its parameters.
export function safeError(error: unknown) {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  return /query|insert|update|select|delete/i.test(error.message)
    ? `${error.name}${code ? ` ${String(code)}` : ""}`
    : error.message.slice(0, 200);
}

// The key is wrong or the balance is empty: the owner hears it in JARVIS, at most hourly.
async function alertOwnerClaudeUnavailable(error: unknown) {
  if (Date.now() - lastOwnerAlertAt < OWNER_ALERT_EVERY_MS) return;
  lastOwnerAlertAt = Date.now();
  const [ownerTelegramId] = [...getAllowedTelegramUserIds()];
  if (!ownerTelegramId) return;
  await getBot()
    .api.sendMessage(
      ownerTelegramId,
      `⚠️ Тренер в тренерском боте не может ответить: Claude API отказал (${error instanceof Error ? error.message.slice(0, 120) : "ошибка"}). Проверьте ключ и баланс в Claude Console.`,
    )
    .catch(() => undefined);
}

type TelegramMessage = {
  message_id: number;
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string };
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
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
  const match = /^\/intervals(?:@\w+)?\s+(i?\d{2,12})[\s,;:]+([A-Za-z0-9_-]{8,128})\s*$/i.exec(
    text.trim(),
  );
  if (!match) return null;
  const athleteId = match[1].toLowerCase().startsWith("i")
    ? match[1].toLowerCase()
    : `i${match[1]}`;
  return { athleteId, apiKey: match[2] };
}

// Every reading of the command worth trying against Intervals.icu. Pasted without spaces
// ("/intervalsi123456abc…") the end of the id is unknown — the key may start with digits —
// so each split is a candidate, longest id first; only the right one is accepted.
export function intervalsCandidates(text: string) {
  const spaced = parseIntervalsCommand(text);
  if (spaced) return [spaced];
  const body = text
    .trim()
    .replace(/^\/intervals(?:@\w+)?/i, "")
    .replace(/[\s,;:]+/g, "");
  const glued = /^i?(\d{3,})([A-Za-z0-9_-]+)$/i.exec(body);
  if (!glued) return [];
  const [, digits, rest] = glued;
  const candidates: Array<{ athleteId: string; apiKey: string }> = [];
  for (let length = digits.length; length >= 3 && candidates.length < 8; length -= 1) {
    const apiKey = `${digits.slice(length)}${rest}`;
    if (apiKey.length >= 16) candidates.push({ athleteId: `i${digits.slice(0, length)}`, apiKey });
  }
  return candidates;
}

// "/intervals…" counts even when the id is glued to it; other commands need a word end.
function commandOf(text: string) {
  if (/^\/intervals/i.test(text)) return "intervals";
  return /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

async function refuseSecret(message: TelegramMessage) {
  await athleteBotApi()
    .deleteMessage(message.chat.id, message.message_id)
    .catch(() => undefined);
  await sendAthleteText(
    message.chat.id,
    "Похоже, в сообщении был ключ или пароль — я его удалил из чата и никуда не отправлял. Если это ключ Intervals.icu, пришли его так: /intervals i123456 ключ",
  );
}

// A long letters-and-digits run in a chat message is most likely a pasted key.
export function looksLikeSecret(text: string) {
  return (
    /^\/intervals/i.test(text.trim()) ||
    /(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{20,}/.test(text)
  );
}

// Checks the key with Intervals.icu, stores it encrypted, removes the message with the
// key from the chat and imports the last month. When the owner does it for the athlete,
// the athlete hears about it in their own chat.
async function connectIntervals(
  user: User,
  message: TelegramMessage,
  text: string,
  athleteChatId?: bigint,
) {
  const chatId = message.chat.id;
  // Whatever follows the command may be a key: it leaves the chat before anything else.
  if (text.replace(/^\/intervals(?:@\w+)?/i, "").trim()) {
    await athleteBotApi()
      .deleteMessage(chatId, message.message_id)
      .catch(() => undefined);
  }
  const candidates = intervalsCandidates(text);
  if (!candidates.length) {
    await sendAthleteText(
      chatId,
      "Пришли одной строкой: /intervals i123456 ключ\nAthlete ID и API Key — на intervals.icu в Settings, раздел Developer Settings.",
    );
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  let parsed: { athleteId: string; apiKey: string } | null = null;
  let unavailable = false;
  for (const candidate of candidates) {
    try {
      await fetchIntervals("activities", { oldest: today, newest: today }, candidate);
      parsed = candidate;
      break;
    } catch (error) {
      const status = error instanceof IntervalsApiError ? error.status : 0;
      if (![401, 403, 404].includes(status)) unavailable = true;
    }
  }
  if (!parsed) {
    await sendAthleteText(
      chatId,
      unavailable
        ? "Intervals.icu сейчас не ответил. Попробуй ещё раз через пару минут. Сообщение с ключом я удалил."
        : "Intervals.icu не принял этот ID и ключ. Проверь Athlete ID (вида i123456) и создай ключ заново в Settings → Developer Settings. Сообщение с ключом я удалил.",
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
  if (athleteChatId) {
    await sendAthleteText(
      athleteChatId,
      "✅ Intervals.icu подключён: тренировки, сон и пульс теперь приходят сами. После каждой тренировки пришлю разбор, а вопросы можно задавать обычными сообщениями.",
    ).catch(() => undefined);
  }
}

// The owner in the coach bot: sets up the athlete's Intervals.icu, profile and FTP from
// their own Telegram, so the athlete only has to press Start. Questions to the coach stay
// the athlete's. The coach bot never journals messages, so the key is only stored encrypted.
async function handleOwner(message: TelegramMessage) {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  const command = commandOf(text);
  const rest = command ? text.replace(/^\/\S+\s*/, "").trim() : "";
  const [target] = await listApprovedAthletes();
  if (!target) {
    await sendAthleteText(
      chatId,
      "Вы владелец. Спортсменов пока нет: пусть человек нажмёт Start в этом боте, а вы — «Дать доступ» в JARVIS. Потом здесь можно будет подключить за него Intervals.icu и заполнить профиль.",
    );
    return;
  }
  const { user, connection } = target;
  const name = connection.firstName ?? connection.telegramUsername ?? "спортсмен";
  switch (command) {
    case "intervals":
      return connectIntervals(user, message, text, user.telegramUserId);
    case "profile": {
      // Her chat, memory and analyses are hers: the owner may start a profile, never read
      // it, and never overwrite what she wrote herself.
      const current = await getCoachProfile(user.id);
      const hers = current?.settings?.profileBy === "athlete";
      if (rest && !hers) {
        await saveAthleteProfile(user, rest, "owner");
        await sendAthleteText(chatId, `✅ Профиль «${name}» сохранён.`);
        return;
      }
      await sendAthleteText(
        chatId,
        hers
          ? `Профиль «${name}» заполнен ею самой — менять и читать его отсюда нельзя.`
          : `Профиль «${name}» ${current?.profile?.trim() ? "заполнен" : "пуст"}. Заменить: /profile и новый текст целиком.`,
      );
      return;
    }
    case "ftp": {
      const ftp = await saveAthleteFtp(user, rest);
      await sendAthleteText(
        chatId,
        ftp ? `✅ FTP «${name}» — ${ftp} Вт.` : "Напишите FTP в ваттах, например: /ftp 210",
      );
      return;
    }
    default:
      await sendAthleteText(
        chatId,
        `Вы владелец. Здесь можно настроить тренера за «${name}»:\n• /intervals i123456 ключ — подключить Intervals.icu (сообщение с ключом я сразу удалю)\n• /profile текст — профиль: старт, дата, цель, опыт, сколько часов в неделю\n• /ftp 210 — FTP\n\n${await statusText(user, connection)}\n\nВопросы тренеру и разборы — в чате самого спортсмена.`,
      );
  }
}

async function saveAthleteProfile(user: User, text: string, by: "athlete" | "owner") {
  const current = await getCoachProfile(user.id);
  await saveCoachProfile({
    userId: user.id,
    profile: text,
    settings: { ...(current?.settings ?? {}), profileBy: by },
  });
}

async function saveAthleteFtp(user: User, raw: string) {
  const ftp = Math.round(Number(raw.replace(",", ".")));
  if (!Number.isFinite(ftp) || ftp < 80 || ftp > 500) return null;
  const current = await getCoachProfile(user.id);
  await saveCoachProfile({
    userId: user.id,
    profile: current?.profile ?? "",
    settings: { ...(current?.settings ?? {}), ftp },
  });
  return ftp;
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

async function downloadTelegramFile(fileId: string) {
  const file = await athleteBotApi().getFile(fileId);
  const response = await fetch(
    `https://api.telegram.org/file/bot${athleteBotToken()}/${file.file_path}`,
  );
  if (!response.ok) throw new Error(`telegram_file_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// What a file in the chat is: a workout (.fit), lab results (photo, image or PDF), or neither.
export function classifyAthleteFile(message: {
  photo?: unknown[];
  document?: { file_name?: string; mime_type?: string };
}) {
  if (message.photo?.length) return { kind: "health" as const, mediaType: "image/jpeg" };
  const document = message.document;
  if (!document) return null;
  if (/\.fit$/i.test(document.file_name ?? "")) return { kind: "fit" as const, mediaType: null };
  if (isSupportedHealthType(document.mime_type)) {
    return { kind: "health" as const, mediaType: document.mime_type };
  }
  return { kind: "unknown" as const, mediaType: null };
}

async function readHealthFile(user: User, message: TelegramMessage, mediaType: string) {
  const chatId = message.chat.id;
  if (!isAnthropicConfigured() || !isSupportedHealthType(mediaType)) {
    await sendAthleteText(chatId, "Этот файл прочитать не могу. Пришли фото или PDF анализов.");
    return;
  }
  const photo = message.photo?.at(-1);
  const fileId = photo?.file_id ?? message.document?.file_id;
  const size = photo?.file_size ?? message.document?.file_size ?? 0;
  const limit = mediaType === "application/pdf" ? MAX_HEALTH_BYTES : MAX_IMAGE_BYTES;
  if (!fileId || size > limit) {
    await sendAthleteText(
      chatId,
      mediaType === "application/pdf"
        ? "PDF слишком большой. Пришли файл до 15 МБ или фото страниц."
        : "Картинка слишком большая. Пришли её обычным фото (не файлом) или PDF.",
    );
    return;
  }
  const stop = keepTyping(chatId);
  try {
    const result = await readHealthDocument({
      bytes: await downloadTelegramFile(fileId),
      mediaType,
      caption: message.caption ?? null,
    });
    if (!result.isLabResult) {
      stop();
      await sendAthleteText(
        chatId,
        "Не похоже на результаты анализов. Я читаю фото и PDF анализов и файлы тренировок .fit, а мысли и вопросы — обычным текстом.",
      );
      return;
    }
    const { record, merged } = await saveHealthDocument({ user, result });
    stop();
    const when = record.takenOn ? ` от ${formatTakenOn(record.takenOn)}` : "";
    await sendAthleteMarkdown(
      chatId,
      merged
        ? `🧪 Добавил к «${record.title}»${when}: теперь ${record.items.length} показ.`
        : `🧪 Сохранил: «${record.title}»${when}, ${record.items.length} показ.\n\n${result.summary}\n\nВсе анализы — /analyses`,
    );
  } finally {
    stop();
  }
  // «Что скажешь?» under the photo is a question: answered with the new record in sight.
  const question = message.caption?.trim();
  if (question) await answerQuestion(user, chatId, question);
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
    const messages = await uploadRideToCoach({
      user,
      bytes: await downloadTelegramFile(document.file_id),
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
  const command = commandOf(text);
  const rest = command ? text.replace(/^\/\S+\s*/, "").trim() : text;

  const file = classifyAthleteFile(message);
  if (file?.kind === "fit") return reviewFitFile(user, message);
  if (file?.kind === "health" && file.mediaType) {
    return readHealthFile(user, message, file.mediaType);
  }
  if (file?.kind === "unknown") {
    await sendAthleteText(
      chatId,
      "Этот файл не прочитаю. Понимаю фото и PDF анализов и файлы тренировок .fit. Снимок с iPhone (HEIC) отправь обычным фото, не файлом.",
    );
    return;
  }
  if (!text) {
    await sendAthleteText(
      chatId,
      "Понимаю текст, фото и PDF анализов и файлы тренировок .fit. Голосовые пока не слушаю.",
    );
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
      if (rest) {
        await saveAthleteProfile(user, rest, "athlete");
        await sendAthleteText(
          chatId,
          "✅ Профиль сохранён. Тренер будет опираться на него; обновить — снова /profile и новый текст целиком.",
        );
        return;
      }
      const profile = (await getCoachProfile(user.id))?.profile?.trim();
      await sendAthleteText(
        chatId,
        profile ? `Твой профиль:\n\n${profile}\n\n${PROFILE_TEMPLATE}` : PROFILE_TEMPLATE,
      );
      return;
    }
    case "ftp": {
      const ftp = await saveAthleteFtp(user, rest);
      await sendAthleteText(
        chatId,
        ftp ? `✅ FTP ${ftp} Вт сохранён.` : "Напиши FTP в ваттах, например: /ftp 210",
      );
      return;
    }
    case "memory": {
      const memories = await listActiveMemories(user.id);
      await sendAthleteText(
        chatId,
        memories.length
          ? `Что я о тебе помню:\n\n${memories.map((memory, index) => `${index + 1}. ${memory.fact}`).join("\n")}\n\nЕсли что-то не так — /forget и номер пункта, например /forget 2. А новое просто расскажи в чате.`
          : "Пока ничего не запомнил. Расскажи о себе обычным сообщением — что важно знать тренеру, я запомню.",
      );
      return;
    }
    case "forget": {
      const removed = await removeMemoryAt(user.id, Number(rest));
      await sendAthleteText(
        chatId,
        removed
          ? `Забыл: «${removed.fact}».`
          : "Напиши номер пункта из /memory, например /forget 2.",
      );
      return;
    }
    case "analyses": {
      const records = await listHealthRecords(user.id);
      await sendAthleteText(
        chatId,
        records.length
          ? `Твои анализы:\n\n${healthRecordsList(records)}\n\nНовые — пришли фото или PDF прямо сюда. Удалить — /analyses_delete и номер.`
          : "Анализов пока нет. Пришли фото или PDF результатов прямо сюда — я их прочитаю и сохраню.",
      );
      return;
    }
    case "analyses_delete": {
      const removed = await deleteHealthRecordAt(user.id, Number(rest));
      await sendAthleteText(
        chatId,
        removed
          ? `Удалил: ${removed.title} от ${formatTakenOn(removed.takenOn)}.`
          : "Напиши номер из /analyses, например /analyses_delete 3.",
      );
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
      // A pasted key never reaches the chat history or the model.
      if (looksLikeSecret(text)) return refuseSecret(message);
      return answerQuestion(user, chatId, text);
  }
}

// One update of the coach bot. Only approved people get the coach; anyone else's first
// message becomes a request the owner answers in JARVIS.
export async function handleAthleteUpdate(update: TelegramUpdate) {
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.chat.type !== "private") return;
  const from = message.from;
  if (getAllowedTelegramUserIds().has(String(from.id))) {
    await handleOwner(message).catch(async (error) => {
      logger.warn("Coach bot owner command failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await sendAthleteText(message.chat.id, "Не получилось. Попробуйте ещё раз через минуту.");
    });
    return;
  }
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
    logger.warn("Coach bot message failed", { userId: user.id, error: safeError(error) });
    if (isClaudeUnavailable(error)) {
      await alertOwnerClaudeUnavailable(error);
      await sendAthleteText(
        message.chat.id,
        "Тренер сейчас недоступен — его уже чинят. Напиши чуть позже, я отвечу.",
      ).catch(() => undefined);
      return;
    }
    await sendAthleteText(
      message.chat.id,
      "Не получилось ответить. Попробуй ещё раз через минуту.",
    ).catch(() => undefined);
  }
}
