import { z } from "zod";

import { askClaudeJson, isAnthropicConfigured, isClaudeUnavailable } from "@/ai/anthropicClient";
import { listApprovedAthletes } from "@/db/queries/athletes";
import {
  getCoachProfile,
  insertCoachMessage,
  listAllCoachMessages,
  mergeCoachSettings,
} from "@/db/queries/coach";
import {
  applyMemoryChanges,
  listActiveMemories,
  listHealthRecords,
} from "@/db/queries/coachMemory";
import type { User } from "@/db/schema";
import { healthRecordsList } from "@/domain/athleteMemory";
import { logger } from "@/lib/logger";
import {
  buildCoachContext,
  conversationTranscript,
  TRIATHLON_COACH_INSTRUCTIONS,
} from "@/services/coach";

import { ATHLETE_BOT_COMMANDS } from "./access";
import { athleteBotApi, isAthleteBotConfigured, sendAthleteMarkdown } from "./telegram";

// Once per athlete, when the coach moves to Claude Opus: it introduces itself, says what is
// new, which analyses it already has and who can see the chat. Only for an athlete whose
// analyses were added for them by the owner — the message says so.

type WelcomeState = { claimedAt?: string; sentAt?: string; attempts?: number };

const KEY = "claudeWelcome";
// A claim older than this without "sent" is a run that died (the 120 s limit): take it over.
const CLAIM_LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// Her whole chat so far fits easily; the cap only guards a very long one.
const HISTORY_MESSAGES = 200;
// The one quiet pass over the old chat, for an athlete welcomed before the coach read it.
const HISTORY_KEY = "historyMemory";

export function welcomeDue(state: WelcomeState | undefined, now: Date) {
  if (state?.sentAt) return false;
  if ((state?.attempts ?? 0) >= MAX_ATTEMPTS) return false;
  if (!state?.claimedAt) return true;
  return now.getTime() - Date.parse(state.claimedAt) > CLAIM_LEASE_MS;
}

export function welcomeInstruction(params: { remembered: string | null; analyses: string }) {
  const example = params.remembered
    ? ` Например, ты уже помнишь: «${params.remembered}» — больше переспрашивать и пугать этим не будешь.`
    : "";
  return `Сейчас ты пишешь ей первое сообщение как обновлённый тренер. До этого с ней работал более простой помощник, который забывал сказанное; теперь тренер работает на модели Claude Opus. Это сообщение отправляется ей само, она ничего не спрашивала.

Обязательно скажи, своими словами, спокойно и коротко (не больше 15 строк, без таблиц и заголовков):
1. Теперь с ней работает обновлённый тренер (Claude Opus): лучше понимает и надолго запоминает всё, что она расскажет о себе.${example}
2. Её анализы уже сохранены — их передал её муж. Перечисли их коротко, по датам (список ниже), и скажи, что по ним можно задавать любые вопросы, а новые анализы — присылать фото или PDF прямо сюда.
3. Сюда можно писать всё: вопросы про тренировки и подготовку к старту, самочувствие, мысли и сомнения — в любое время и любыми словами.
4. Эту переписку, её анализы и то, что ты о ней помнишь, видит только она: ни муж, ни его приложение их не видят.
5. Команды: /memory — что ты о ней помнишь, /analyses — её анализы.
В конце — одна короткая полезная мысль по её анализам или последним тренировкам, без запугивания и без диагнозов.
Не называй себя ИИ, нейросетью или ботом, кроме одного упоминания Claude Opus в первом пункте. Без восторгов.

Её анализы (новые сверху):
${params.analyses}`;
}

// Before the coach starts, it reads everything she has written to the bot so far: what she
// told about herself, asked for, disliked. What lasts goes to her long memory.
export const HISTORY_INSTRUCTION = `Прочитай всю вашу прошлую переписку (ниже, от старых сообщений к новым) и её профиль: что она рассказывала о себе, о чём просила, что ей не понравилось, как ей удобнее общаться. Раньше с ней работал более простой помощник — его советы могли противоречить её словам; опирайся на её слова и данные, а не на его выводы.
В remember верни устойчивые факты о ней из этой переписки и профиля, которых ещё нет в «Что она рассказала о себе»: её нормы и ощущения, ограничения и здоровье, цели и старты, расписание, предпочтения в тренировках и в общении. Коротко, от третьего лица, не больше 10.`;

const WELCOME_HISTORY_NOTE = `В приветствии покажи одной-двумя фразами по делу, что ты всё это учёл (например, что знаешь её старт и как ей удобнее тренироваться). Не пересказывай переписку и не извиняйся за прошлого помощника.`;

const QUIET_HISTORY_NOTE = `Ей сейчас ничего не отправляется: ты только запоминаешь, чтобы дальше помогать ей с учётом всего этого.`;

const REMEMBER_PROPERTY = { type: "array", items: { type: "string" } };

const WELCOME_WITH_MEMORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message", "remember"],
  properties: { message: { type: "string" }, remember: REMEMBER_PROPERTY },
};

const HISTORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["remember"],
  properties: { remember: REMEMBER_PROPERTY },
};

const rememberList = z
  .array(z.string())
  .catch([])
  .transform((facts) => facts.slice(0, 10));

async function historyTranscript(user: User, closing: string) {
  const messages = await listAllCoachMessages(user.id);
  return conversationTranscript(
    messages.slice(-HISTORY_MESSAGES),
    user.timezone,
    "Тренер",
    "Спортсменка",
    closing,
  );
}

async function writeWelcome(user: User, now: Date, analyses: string) {
  const [first] = await listActiveMemories(user.id);
  const context = await buildCoachContext(user, now);
  const { data, model } = await askClaudeJson<unknown>({
    system: [
      { text: TRIATHLON_COACH_INSTRUCTIONS, cache: true },
      {
        text: `${welcomeInstruction({ remembered: first?.fact ?? null, analyses })}\n\n${HISTORY_INSTRUCTION}\n${WELCOME_HISTORY_NOTE}\n\n# Данные\n${context}`,
      },
    ],
    content: await historyTranscript(user, "Теперь напиши приветствие по инструкции."),
    schema: WELCOME_WITH_MEMORY_SCHEMA,
    effort: "high",
  });
  const parsed = z
    .object({ message: z.string().trim().min(40), remember: rememberList })
    .parse(data);
  await applyMemoryChanges({ userId: user.id, remember: parsed.remember, forget: [] }).catch(
    () => undefined,
  );
  return { message: parsed.message, model };
}

// One athlete per scheduler tick, so a slow answer never pushes another past the time limit.
export async function sendClaudeWelcomeIfDue(now = new Date()) {
  if (!isAthleteBotConfigured() || !isAnthropicConfigured()) return { sent: 0 };
  for (const { user } of await listApprovedAthletes()) {
    const state = (await getCoachProfile(user.id))?.settings?.[KEY] as WelcomeState | undefined;
    if (!welcomeDue(state, now)) continue;
    const records = await listHealthRecords(user.id);
    if (!records.some((record) => record.source === "owner")) continue;
    const attempts = (state?.attempts ?? 0) + 1;
    await mergeCoachSettings(user.id, { [KEY]: { claimedAt: now.toISOString(), attempts } });
    try {
      const { message, model } = await writeWelcome(user, now, healthRecordsList(records));
      await sendAthleteMarkdown(user.telegramUserId, message);
      // Sent: never again, whatever happens below. The welcome has read the old chat too.
      const sentAt = new Date().toISOString();
      await mergeCoachSettings(user.id, {
        [KEY]: { claimedAt: now.toISOString(), attempts, sentAt },
        [HISTORY_KEY]: { sentAt },
      });
      await insertCoachMessage({
        userId: user.id,
        role: "assistant",
        content: message,
        metadata: { engine: "anthropic", model, welcome: true },
      }).catch(() => undefined);
      await athleteBotApi()
        .setMyCommands(ATHLETE_BOT_COMMANDS)
        .catch(() => undefined);
      return { sent: 1 };
    } catch (error) {
      // A key or balance problem is not the message's fault: no attempt is used up, and it
      // goes out by itself once the key works.
      if (isClaudeUnavailable(error)) {
        await mergeCoachSettings(user.id, { [KEY]: { attempts: attempts - 1 } });
      }
      // Otherwise the claim stays, and the lease lets a later tick try again (3 at most).
      logger.warn("Coach welcome failed", {
        userId: user.id,
        attempts,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      return { sent: 0 };
    }
  }
  return { sent: 0 };
}

// Her welcome went out before the coach could read the old chat: one quiet pass over the
// whole history, nothing is sent to her, what it learned goes to her long memory. In this
// state "sentAt" means "done".
export async function learnFromHistoryIfDue(now = new Date()) {
  if (!isAnthropicConfigured()) return { added: 0 };
  for (const { user } of await listApprovedAthletes()) {
    const settings = (await getCoachProfile(user.id))?.settings;
    const welcome = settings?.[KEY] as WelcomeState | undefined;
    const state = settings?.[HISTORY_KEY] as WelcomeState | undefined;
    if (!welcome?.sentAt || !welcomeDue(state, now)) continue;
    const attempts = (state?.attempts ?? 0) + 1;
    await mergeCoachSettings(user.id, {
      [HISTORY_KEY]: { claimedAt: now.toISOString(), attempts },
    });
    try {
      const context = await buildCoachContext(user, now);
      const { data } = await askClaudeJson<unknown>({
        system: [
          { text: TRIATHLON_COACH_INSTRUCTIONS, cache: true },
          { text: `${HISTORY_INSTRUCTION}\n${QUIET_HISTORY_NOTE}\n\n# Данные\n${context}` },
        ],
        content: await historyTranscript(user, "Теперь верни remember по инструкции."),
        schema: HISTORY_SCHEMA,
        effort: "high",
      });
      const remember = z.object({ remember: rememberList }).parse(data).remember;
      const { added } = await applyMemoryChanges({ userId: user.id, remember, forget: [] });
      await mergeCoachSettings(user.id, {
        [HISTORY_KEY]: { claimedAt: now.toISOString(), attempts, sentAt: new Date().toISOString() },
      });
      logger.info("Coach learned from the old chat", { userId: user.id, added });
      return { added };
    } catch (error) {
      if (isClaudeUnavailable(error)) {
        await mergeCoachSettings(user.id, { [HISTORY_KEY]: { attempts: attempts - 1 } });
      }
      logger.warn("Coach history pass failed", {
        userId: user.id,
        attempts,
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      return { added: 0 };
    }
  }
  return { added: 0 };
}
