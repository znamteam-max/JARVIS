import { InlineKeyboard } from "grammy";

import { getBot } from "@/bot/createBot";
import {
  getAthleteConnection,
  requestAthleteAccess,
  setAthleteDecision,
} from "@/db/queries/athletes";
import { createAthleteUser, type TelegramProfile } from "@/db/queries/users";
import { getAllowedTelegramUserIds, getOwnerTimezone } from "@/lib/env";

import {
  athleteBotApi,
  athleteWebhookSecret,
  athleteWebhookUrl,
  sendAthleteText,
} from "./telegram";

const REQUEST_REPEAT_MS = 24 * 60 * 60 * 1000;

export const ATHLETE_BOT_COMMANDS = [
  { command: "start", description: "Что умеет тренер и что подключено" },
  { command: "intervals", description: "Подключить Intervals.icu (Garmin, Zwift)" },
  { command: "profile", description: "Профиль: старт, цель, уровень, время" },
  { command: "ftp", description: "Задать FTP, например /ftp 210" },
  { command: "new", description: "Начать новый разговор" },
  { command: "export", description: "История переписки файлом" },
];

export const ATHLETE_WELCOME = `Привет! Я твой тренер по триатлону: разбираю каждую тренировку и отвечаю на вопросы про план и подготовку к половинке Айронмена.

Чтобы я видел тренировки, сон и пульс:
1. Зарегистрируйся на intervals.icu (бесплатно).
2. Там в Settings → Connections подключи Garmin Connect и Zwift. Strava не нужна: её тренировки Intervals другим программам не передаёт.
3. В Settings внизу, в разделе Developer Settings, возьми Athlete ID (вида i123456) и создай API Key.
4. Пришли мне одной строкой: /intervals i123456 ключ
Сообщение с ключом я сразу удалю из чата и сохраню ключ в зашифрованном виде.

Потом расскажи о себе: /profile и дальше текстом — какой старт и когда, цель по времени, опыт, сколько сейчас тренируешься, лучшие результаты, травмы, есть ли бассейн, сколько часов в неделю готова тратить.

После этого после каждой тренировки будет приходить разбор, а спрашивать можно обычными сообщениями: «что делать сегодня?», «план на неделю», «как подготовиться к плаванию в открытой воде».`;

function displayName(profile: { firstName?: string | null; username?: string | null }) {
  return [profile.firstName, profile.username ? `@${profile.username}` : null]
    .filter(Boolean)
    .join(" ");
}

// The first /start of someone new: they wait, the owner gets two buttons in JARVIS.
export async function askOwnerForAthleteAccess(profile: TelegramProfile) {
  const { created, connection } = await requestAthleteAccess(profile);
  const stale = Date.now() - connection.updatedAt.getTime() > REQUEST_REPEAT_MS;
  if (!created && !stale) return;
  const [ownerTelegramId] = [...getAllowedTelegramUserIds()];
  if (!ownerTelegramId) return;
  await getBot().api.sendMessage(
    ownerTelegramId,
    `🏃 В тренерский бот пишет ${displayName(profile) || "новый человек"} (id ${profile.id}). Дать доступ к тренеру?\nУ этого человека будут свои тренировки и своя переписка; к расписанию и вашим данным доступа нет.`,
    {
      reply_markup: new InlineKeyboard()
        .text("✅ Дать доступ", `athlete:approve:${profile.id}`)
        .text("Отказать", `athlete:deny:${profile.id}`),
    },
  );
}

export async function decideAthleteAccess(params: {
  telegramUserId: string;
  decision: "approve" | "deny";
}) {
  const connection = await getAthleteConnection(params.telegramUserId);
  if (!connection) return { outcome: "missing" as const };
  // The owner is the planner's user; they never become an athlete row.
  if (getAllowedTelegramUserIds().has(params.telegramUserId)) {
    return { outcome: "owner" as const };
  }
  const name = displayName(connection) || `id ${params.telegramUserId}`;
  if (params.decision === "deny") {
    await setAthleteDecision({ telegramUserId: params.telegramUserId, status: "denied" });
    await sendAthleteText(params.telegramUserId, "Доступ к тренеру не подтверждён.").catch(
      () => undefined,
    );
    return { outcome: "denied" as const, name };
  }
  const user = await createAthleteUser({
    id: params.telegramUserId,
    username: connection.telegramUsername ?? undefined,
    firstName: connection.firstName ?? undefined,
    timezone: getOwnerTimezone(),
  });
  await setAthleteDecision({
    telegramUserId: params.telegramUserId,
    status: "approved",
    userId: user.id,
  });
  await sendAthleteText(params.telegramUserId, ATHLETE_WELCOME, {
    link_preview_options: { is_disabled: true },
  }).catch(() => undefined);
  return { outcome: "approved" as const, name };
}

// /athletebot in JARVIS: points the coach bot at this app and sets its command menu.
export async function connectAthleteBot() {
  const api = athleteBotApi();
  const me = await api.getMe();
  await api.setWebhook(athleteWebhookUrl(), {
    secret_token: athleteWebhookSecret(),
    allowed_updates: ["message"],
  });
  await api.setMyCommands(ATHLETE_BOT_COMMANDS);
  const info = await api.getWebhookInfo();
  return { username: me.username, url: info.url, pending: info.pending_update_count };
}
