import { DateTime } from "luxon";
import { z } from "zod";

import { askClaudeRelay, isClaudeRelayConfigured } from "@/ai/claudeRelay";
import { writeAudit } from "@/db/queries/audit";
import { insertCoachMessage, listActiveCoachMessages } from "@/db/queries/coach";
import type { CoachMessage, User } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  buildCoachContext,
  COACH_INSTRUCTIONS,
  generateCoachReply,
  guardCoachDailyLimit,
  listCoachConversation,
} from "@/services/coach";
import { logFoodFromText } from "@/services/foodLog";
import {
  createPlannerItemFromApp,
  logManualWorkout,
  REMINDER_CHOICES,
  type ReminderChoice,
} from "@/services/miniappCreate";
import { buildMiniAppSummary, type MiniAppSummary } from "@/services/miniappSummary";
import { completePlannerItemFromApp } from "@/services/plannerItemComplete";
import { deletePlannerItemEverywhere } from "@/services/plannerItemDelete";
import { editPlannerItemFromApp } from "@/services/plannerItemEdit";

const HISTORY_MESSAGES = 16;
const MAX_ACTIONS = 5;
const CHAT_TIMEOUT_MS = 40_000;

const ACTION_TYPES = [
  "create_item",
  "update_item",
  "delete_item",
  "complete_item",
  "log_food",
  "log_workout",
] as const;
const SPORTS = [
  "Run",
  "Ride",
  "VirtualRide",
  "WeightTraining",
  "Walk",
  "Swim",
  "Yoga",
  "Workout",
] as const;
const REMINDERS = Object.keys(REMINDER_CHOICES) as ReminderChoice[];

const OPERATOR_INSTRUCTIONS = `Ты — JARVIS: ещё и ведёшь расписание, еду и тренировки владельца. Ты сам ничего не выполняешь — ты возвращаешь решение (JSON), а приложение выполняет действия из actions.

Если последнее сообщение владельца — просьба что-то сделать, верни нужные actions:
- create_item: новое дело. kind: task (задача/напоминалка), event (встреча), training (плановая тренировка). date YYYY-MM-DD, time HH:MM (можно null у задачи без срока). duration_minutes — для встреч. reminders — быстрые варианты: at_time (в момент), 15m, 1h, 2h, 1d; сложное («каждый час с 8 до 12», «пока не сделаю») — в reminders_text.
- update_item: изменить дело из списка «Дела (можно менять)» по item_id: title, start/end (YYYY-MM-DDTHH:MM, для встреч), deadline (для задач) или clear_deadline, reminders_text (новые напоминания заменят старые).
- delete_item / complete_item: только item_id. Делай это, только если владелец явно назвал дело; если подходит несколько или непонятно какое — actions пустой, переспроси в reply.
- log_food: food_text — что и сколько съел своими словами; eaten_at — если было не сейчас.
- log_workout: тренировка, которую не записали часы: sport, duration_minutes, workout_start (если не сейчас), calories и distance_km — если владелец их назвал.
Даты «завтра», «в пятницу», «21-го» считай от «Сейчас» в его часовом поясе. item_id бери только из списка дел, не выдумывай.
Если сообщение — вопрос или разговор, actions пустой.
reply — коротко по-русски: что сделано (или что уточнить), без повторения всех полей. Для вопросов о тренировках отвечай как тренер по правилам выше.`;

const nullableString = { type: ["string", "null"] };
const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "actions"],
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      maxItems: MAX_ACTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { type: "string", enum: [...ACTION_TYPES] },
          item_id: nullableString,
          kind: { type: ["string", "null"], enum: ["task", "event", "training", null] },
          title: nullableString,
          date: nullableString,
          time: nullableString,
          duration_minutes: { type: ["integer", "null"] },
          reminders: { type: ["array", "null"], items: { type: "string", enum: REMINDERS } },
          reminders_text: nullableString,
          start: nullableString,
          end: nullableString,
          deadline: nullableString,
          clear_deadline: { type: ["boolean", "null"] },
          food_text: nullableString,
          eaten_at: nullableString,
          sport: { type: ["string", "null"], enum: [...SPORTS, null] },
          workout_start: nullableString,
          calories: { type: ["number", "null"] },
          distance_km: { type: ["number", "null"] },
        },
      },
    },
  },
} as const;

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTime = z.string().regex(/^\d{2}:\d{2}$/);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  item_id: z.string().uuid().nullish(),
  kind: z.enum(["task", "event", "training"]).nullish(),
  title: z.string().trim().min(1).max(300).nullish(),
  date: localDate.nullish(),
  time: localTime.nullish(),
  duration_minutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .nullish(),
  reminders: z
    .array(z.enum(REMINDERS as [ReminderChoice, ...ReminderChoice[]]))
    .max(5)
    .nullish(),
  reminders_text: z.string().trim().max(300).nullish(),
  start: localDateTime.nullish(),
  end: localDateTime.nullish(),
  deadline: localDateTime.nullish(),
  clear_deadline: z.boolean().nullish(),
  food_text: z.string().trim().min(2).max(500).nullish(),
  eaten_at: localDateTime.nullish(),
  sport: z.enum(SPORTS).nullish(),
  workout_start: localDateTime.nullish(),
  calories: z.number().min(0).max(5000).nullish(),
  distance_km: z.number().min(0).max(500).nullish(),
});

export type JarvisAction = z.infer<typeof actionSchema>;

// Claude's answer is checked field by field; a malformed action is dropped, never guessed.
export function parseJarvisDecision(raw: unknown) {
  const object = (raw ?? {}) as { reply?: unknown; actions?: unknown };
  const reply = typeof object.reply === "string" ? object.reply.trim() : "";
  const list = Array.isArray(object.actions) ? object.actions.slice(0, MAX_ACTIONS) : [];
  const actions: JarvisAction[] = [];
  let invalid = 0;
  for (const candidate of list) {
    const parsed = actionSchema.safeParse(candidate);
    if (parsed.success) actions.push(parsed.data);
    else invalid += 1;
  }
  return { reply, actions, invalid };
}

// The schedule as the model may touch it: only the owner's own items, with their ids.
export function editableItemsBlock(plan: MiniAppSummary["plan"]) {
  const lines = plan.flatMap((section) =>
    section.rows
      .filter((row) => row.item)
      .map((row) => {
        const details = row.details.length ? ` (${row.details.join("; ")})` : "";
        return `- ${row.item!.id} | ${section.title}: ${row.text}${details}`;
      }),
  );
  return [
    "## Дела (можно менять) — item_id | раздел: описание",
    lines.length ? lines.join("\n") : "Своих дел в плане нет.",
  ].join("\n");
}

function transcript(history: CoachMessage[]) {
  const lines = history.map((message) => {
    const who =
      message.metadata?.auto === true
        ? "Система"
        : message.role === "assistant"
          ? "JARVIS"
          : "Владелец";
    return `${who}: ${message.content}`;
  });
  return `Переписка (последние сообщения):\n\n${lines.join("\n\n")}\n\nОтветь на последнее сообщение владельца.`;
}

async function decide(user: User, now: Date, history: CoachMessage[]) {
  const summary = await buildMiniAppSummary(user, now);
  const context = await buildCoachContext(user, now, summary);
  const system = [
    COACH_INSTRUCTIONS,
    OPERATOR_INSTRUCTIONS,
    `# Данные\n${context}`,
    editableItemsBlock(summary.plan),
  ].join("\n\n");
  const answer = await askClaudeRelay({
    system,
    prompt: transcript(history),
    schema: DECISION_SCHEMA as unknown as Record<string, unknown>,
    model: getEnv().CLAUDE_CHAT_MODEL,
    effort: "medium",
    timeoutMs: CHAT_TIMEOUT_MS,
  });
  return { ...parseJarvisDecision(answer.structured), model: answer.model };
}

function whenLabel(date: Date | null, timezone: string) {
  return date
    ? DateTime.fromJSDate(date, { zone: "utc" })
        .setZone(timezone)
        .setLocale("ru")
        .toFormat("ccc d MMMM, HH:mm")
    : null;
}

async function execute(user: User, action: JarvisAction, now: Date): Promise<string> {
  const tz = user.timezone;
  switch (action.type) {
    case "create_item": {
      if (!action.title) throw new Error("нет названия");
      const kind = action.kind ?? "task";
      const { item } = await createPlannerItemFromApp({
        user,
        kind,
        title: action.title,
        dateLocal: action.date ?? null,
        timeLocal: action.time ?? null,
        durationMinutes: action.duration_minutes ?? 60,
        reminders:
          action.reminders ??
          (action.date && action.time ? [kind === "task" ? "at_time" : "1h"] : []),
        remindersText: action.reminders_text ?? null,
        now,
      });
      const when = whenLabel(item.startAt ?? item.dueAt, tz);
      return `✅ Добавил «${item.title}»${when ? ` — ${when}` : ""}`;
    }
    case "update_item": {
      if (!action.item_id) throw new Error("не указано дело");
      const { item } = await editPlannerItemFromApp({
        user,
        itemId: action.item_id,
        title: action.title,
        startLocal: action.start,
        endLocal: action.end,
        dueLocal: action.deadline,
        clearDeadline: action.clear_deadline ?? false,
        remindersText: action.reminders_text,
      });
      return `✏️ Изменил «${item.title}»`;
    }
    case "delete_item": {
      if (!action.item_id) throw new Error("не указано дело");
      const deleted = await deletePlannerItemEverywhere({
        userId: user.id,
        itemId: action.item_id,
        source: "jarvis_chat",
      });
      if (!deleted) throw new Error("дело не найдено");
      return `🗑 Удалил «${deleted.item.title}»`;
    }
    case "complete_item": {
      if (!action.item_id) throw new Error("не указано дело");
      const result = await completePlannerItemFromApp({
        userId: user.id,
        itemId: action.item_id,
        timezone: tz,
      });
      if (result.outcome === "missing") throw new Error("дело не найдено");
      if (result.outcome === "needs_clarification") throw new Error("событие ещё впереди");
      return `✔️ Отметил «${result.item.title}»`;
    }
    case "log_food": {
      if (!action.food_text) throw new Error("не понял, что съедено");
      const { estimate } = await logFoodFromText({
        user,
        text: action.food_text,
        eatenAtLocal: action.eaten_at,
        capability: "food_estimation_jarvis",
      });
      return `🍽 Записал: ${estimate.title} — ${estimate.calories} ккал`;
    }
    case "log_workout": {
      if (!action.sport || !action.duration_minutes) throw new Error("нужны вид и длительность");
      const startLocal =
        action.workout_start ??
        DateTime.fromJSDate(now, { zone: "utc" }).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm");
      const logged = await logManualWorkout({
        user,
        sportType: action.sport,
        startLocal,
        durationMinutes: action.duration_minutes,
        calories: action.calories ?? null,
        distanceKm: action.distance_km ?? null,
      });
      return `🏋️ Записал: ${logged.label}, ${action.duration_minutes} мин, ${logged.estimated ? "≈ " : ""}${logged.calories} ккал`;
    }
  }
}

const FALLBACK_NOTE =
  "Claude сейчас недоступен, отвечаешь ты как запасной помощник. Ничего не меняй в расписании: если владелец просит что-то сделать, скажи, что это не выполнено, и предложи повторить через минуту или сделать кнопками приложения.";

// The JARVIS chat: one message in, Claude decides, the app executes, one answer out.
export async function askJarvis(params: { user: User; message: string; now?: Date }) {
  const { user } = params;
  const now = params.now ?? new Date();
  await guardCoachDailyLimit(user, now);
  await insertCoachMessage({ userId: user.id, role: "user", content: params.message });
  if (!isClaudeRelayConfigured()) {
    await generateCoachReply(user, now, FALLBACK_NOTE, { engine: "openai" });
    return { messages: await listCoachConversation(user.id), changed: false };
  }

  let changed = false;
  try {
    const history = await listActiveCoachMessages(user.id, HISTORY_MESSAGES);
    const decision = await decide(user, now, history);
    const done: string[] = [];
    const failed: string[] = [];
    for (const action of decision.actions) {
      try {
        done.push(await execute(user, action, now));
        changed = true;
      } catch (error) {
        failed.push(
          `⚠️ Не получилось (${action.type}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (decision.invalid) failed.push("⚠️ Часть просьбы не разобрал — уточни, пожалуйста.");
    const content =
      [decision.reply, failed.length ? failed.join("\n") : null].filter(Boolean).join("\n\n") ||
      "Готово.";
    await insertCoachMessage({
      userId: user.id,
      role: "assistant",
      content,
      metadata: { engine: "claude", model: decision.model, done, failed },
    });
    await writeAudit({
      userId: user.id,
      action: "assistant.jarvis_turn",
      entityType: "coach",
      details: { model: decision.model, actions: decision.actions, done, failed },
    }).catch(() => undefined);
  } catch (error) {
    logger.warn("JARVIS via Claude failed, answering with the fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    await generateCoachReply(user, now, FALLBACK_NOTE, { engine: "openai" });
  }
  return { messages: await listCoachConversation(user.id), changed };
}

// Telegram "shadow week": what JARVIS would have done with a bot message, recorded only.
export async function shadowJarvisDecision(user: User, text: string, now = new Date()) {
  if (!isClaudeRelayConfigured()) return;
  try {
    const history = [{ role: "user", content: text, metadata: {} } as unknown as CoachMessage];
    const decision = await decide(user, now, history);
    await writeAudit({
      userId: user.id,
      action: "assistant.jarvis_shadow",
      entityType: "telegram_message",
      details: {
        text,
        reply: decision.reply,
        actions: decision.actions,
        invalid: decision.invalid,
        model: decision.model,
      },
    });
  } catch (error) {
    logger.warn("JARVIS shadow decision failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
