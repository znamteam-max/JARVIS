import { DateTime } from "luxon";
import { z } from "zod";

import { askClaudeRelay, isClaudeRelayConfigured } from "@/ai/claudeRelay";
import { writeAudit } from "@/db/queries/audit";
import { insertCoachMessage, listActiveCoachMessages } from "@/db/queries/coach";
import { stopPoliciesForItem } from "@/db/queries/reminderPolicies";
import { cancelItemReminders } from "@/db/queries/reminders";
import type { CoachMessage, PlannerItem, User } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  buildCoachContext,
  COACH_INSTRUCTIONS,
  conversationTranscript,
  generateCoachReply,
  guardCoachDailyLimit,
  listCoachConversation,
} from "@/services/coach";
import { FoodLogError, logFoodFromText } from "@/services/foodLog";
import {
  addReminderAtLocal,
  AppCreateError,
  createPlannerItemFromApp,
  logManualWorkout,
  REMINDER_CHOICES,
  type ReminderChoice,
} from "@/services/miniappCreate";
import { buildMiniAppSummary, type MiniAppSummary } from "@/services/miniappSummary";
import { completePlannerItemFromApp } from "@/services/plannerItemComplete";
import { deletePlannerItemEverywhere } from "@/services/plannerItemDelete";
import { editPlannerItemFromApp, PlannerItemEditError } from "@/services/plannerItemEdit";
import { projectsContextBlock } from "@/services/projects";

const HISTORY_MESSAGES = 40;
const MAX_ACTIONS = 5;
// Opus with effort "high" over the whole context; the chat route allows 120 s.
const CHAT_TIMEOUT_MS = 100_000;
// The Telegram shadow runs after the webhook answer, inside its 60 s.
const SHADOW_TIMEOUT_MS = 50_000;
// A short rewrite of the reply when an action failed (Sonnet, low effort).
const RECONCILE_TIMEOUT_MS = 25_000;

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

const OPERATOR_INSTRUCTIONS = `Ты — JARVIS: ещё и ведёшь расписание, еду и тренировки владельца. Ты возвращаешь решение (JSON), а приложение выполняет действия из actions. Ты можешь менять расписание: если владелец попросил — делай через actions сразу, без подтверждения, и никогда не пиши, что сам расписание не меняешь. Переспрашивай, только если непонятно, что именно сделать.

Если последнее сообщение владельца — просьба что-то сделать, верни нужные actions:
- create_item: новое дело. kind: task — задача, напоминалка и всё, что надо сделать «до такого-то времени»; event — встреча; training — тренировка с конкретным временем начала. date YYYY-MM-DD, time HH:MM: у task это срок, у event и training — начало. duration_minutes — для встреч и тренировок. Тренировка «до 23:00» или «с дедлайном» без времени начала — это task с time = срок.
  Напоминания: в конкретное время («в 11 и в 17», «утром и вечером», «завтра в 9») — reminder_at: список YYYY-MM-DDTHH:MM, для каждого дня отдельно; относительно срока или начала — reminders: at_time (в момент), 15m, 1h, 2h, 1d; повторяющиеся правила («каждый час с 8 до 12», «пока не сделаю») — reminders_text. Без напоминаний — reminders: [], reminder_at: null и reminders_text: null.
- update_item: изменить дело из списка «Дела (можно менять)» по item_id: title, start/end (YYYY-MM-DDTHH:MM, для встреч и тренировок), deadline (для задач) или clear_deadline, reminder_at или reminders_text (новые напоминания заменят старые), clear_reminders: true — убрать все напоминания. Если меняется тип дела (тренировка в 23:00 → задача до 23:00) — delete_item старого и create_item нового. «Исправь», «замени» уже созданное — меняй его, а не добавляй второе.
- delete_item / complete_item: только item_id. Делай это, только если дело явно названо или однозначно следует из разговора; если подходит несколько — actions пустой, переспроси в reply.
- log_food: food_text — что и сколько съел своими словами; eaten_at — если было не сейчас.
- log_workout: тренировка, которую не записали часы: sport, duration_minutes, workout_start (если не сейчас), calories и distance_km — если владелец их назвал.
Значков и цветов у дел нет. Если просят значок — поставь эмодзи в начало названия: 🚴 вело, 🏃 бег, 🏋️ силовая, 🧘 растяжка.
Даты «завтра», «в пятницу», «21-го» считай от «Сейчас» в его часовом поясе. item_id бери только из списка дел, не выдумывай.
Если сообщение — вопрос или разговор, actions пустой.
reply — по-русски, коротко. Итог действий («✅ Добавил…», «⚠️ Не получилось…») приложение само напишет перед твоим ответом — по факту выполнения. Поэтому в reply не утверждай, что что-то уже сделано, и не перечисляй поля дела: пиши только то, что важно сверх этого — почему так, совет, вопрос. На вопросы о тренировках отвечай как тренер по правилам выше.`;

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
          reminder_at: { type: ["array", "null"], items: { type: "string" } },
          clear_reminders: { type: ["boolean", "null"] },
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
  reminder_at: z.array(localDateTime).max(10).nullish(),
  clear_reminders: z.boolean().nullish(),
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

type ChatHistory = Array<Pick<CoachMessage, "role" | "content" | "createdAt" | "metadata">>;

// Everything Claude gets for one turn; exported so a dry run can replay a real moment.
export async function buildJarvisPrompt(user: User, now: Date, history: ChatHistory) {
  const summary = await buildMiniAppSummary(user, now);
  const context = await buildCoachContext(user, now, summary);
  const projects = await projectsContextBlock(user.id);
  return {
    summary,
    system: [
      COACH_INSTRUCTIONS,
      OPERATOR_INSTRUCTIONS,
      `# Данные\n${context}`,
      editableItemsBlock(summary.plan),
      projects,
    ]
      .filter(Boolean)
      .join("\n\n"),
    prompt: conversationTranscript(history, user.timezone, "JARVIS"),
    schema: DECISION_SCHEMA as unknown as Record<string, unknown>,
  };
}

async function decide(
  user: User,
  now: Date,
  history: ChatHistory,
  options: { effort: "medium" | "high"; timeoutMs: number },
) {
  const { summary, system, prompt, schema } = await buildJarvisPrompt(user, now, history);
  const started = Date.now();
  const answer = await askClaudeRelay({
    system,
    prompt,
    schema,
    model: getEnv().CLAUDE_CHAT_MODEL,
    effort: options.effort,
    timeoutMs: options.timeoutMs,
  });
  const titles = new Map(
    summary.plan.flatMap((section) =>
      section.rows.flatMap((row) => (row.item ? [[row.item.id, row.item.title] as const] : [])),
    ),
  );
  return {
    ...parseJarvisDecision(answer.structured),
    model: answer.model,
    durationMs: Date.now() - started,
    titles,
  };
}

function whenLabel(date: Date | null, timezone: string) {
  return date
    ? DateTime.fromJSDate(date, { zone: "utc" })
        .setZone(timezone)
        .setLocale("ru")
        .toFormat("ccc d MMMM, HH:mm")
    : null;
}

type Outcome = { done?: string; problem?: string };

// "в 11:00 и в 17:00" → ["11:00", "17:00"]: the safety net when the reminder parser gives up.
export function clockTimesIn(text: string | null | undefined) {
  return [...(text ?? "").matchAll(/(?:^|[^\d])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/g)].map(
    (match) => `${match[1].padStart(2, "0")}:${match[2]}`,
  );
}

function timesOnItemDay(item: PlannerItem, text: string | null | undefined, timezone: string) {
  const anchor = item.startAt ?? item.dueAt;
  if (!anchor) return [];
  const day = DateTime.fromJSDate(anchor, { zone: "utc" }).setZone(timezone).toISODate();
  return clockTimesIn(text).map((time) => `${day}T${time}`);
}

// Reminders at exact local times; "replace" first stops the item's old reminders.
async function setExactReminders(item: PlannerItem, locals: string[], now: Date, replace: boolean) {
  if (!locals.length) return [];
  if (replace) {
    await cancelItemReminders(item.userId, item.id);
    await stopPoliciesForItem(item.userId, item.id);
  }
  const added: string[] = [];
  for (const local of [...new Set(locals)].sort()) {
    if (await addReminderAtLocal(item, local, now)) added.push(local);
  }
  return added;
}

async function execute(user: User, action: JarvisAction, now: Date): Promise<Outcome> {
  const tz = user.timezone;
  switch (action.type) {
    case "create_item": {
      if (!action.title) throw new Error("нет названия");
      const kind = action.kind ?? "task";
      const reminders =
        action.reminders ??
        (action.date && action.time && !action.reminders_text && !action.reminder_at?.length
          ? [kind === "task" ? ("at_time" as const) : ("1h" as const)]
          : []);
      const { item, extraUnderstood } = await createPlannerItemFromApp({
        user,
        kind,
        title: action.title,
        dateLocal: action.date ?? null,
        timeLocal: action.time ?? null,
        durationMinutes: action.duration_minutes ?? 60,
        reminders,
        remindersText: action.reminders_text ?? null,
        now,
      });
      const when = whenLabel(item.startAt ?? item.dueAt, tz);
      const whenText = when ? (item.startAt ? ` — ${when}` : ` — до ${when}`) : "";
      // Exact times, plus the safety net for times the reminder parser did not take.
      const exact = [
        ...(action.reminder_at ?? []),
        ...(extraUnderstood === false ? timesOnItemDay(item, action.reminders_text, tz) : []),
      ];
      const added = await setExactReminders(item, exact, now, false);
      const labels = [
        ...reminders.map((choice) => REMINDER_CHOICES[choice].label),
        ...added.map((local) => local.slice(11)),
      ];
      const remindersText =
        action.reminders_text && extraUnderstood !== false
          ? ""
          : labels.length
            ? ` · 🔔 ${labels.join(", ")}`
            : " · без напоминаний";
      return {
        done: `✅ Добавил «${item.title}»${whenText}${remindersText}`,
        problem:
          extraUnderstood === false && !added.length
            ? `Не понял напоминания «${action.reminders_text}» — дело добавил без них`
            : undefined,
      };
    }
    case "update_item": {
      if (!action.item_id) throw new Error("не указано дело");
      const edit = {
        user,
        itemId: action.item_id,
        title: action.title,
        startLocal: action.start,
        endLocal: action.end,
        dueLocal: action.deadline,
        clearDeadline: action.clear_deadline ?? false,
        clearReminders: action.clear_reminders ?? false,
      };
      const cleared = action.clear_reminders ? " · напоминания убрал" : "";
      const exactNote = (added: string[]) =>
        added.length ? ` · 🔔 ${added.map((local) => local.slice(11)).join(", ")}` : "";
      try {
        const { item } = await editPlannerItemFromApp({
          ...edit,
          remindersText: action.reminder_at?.length ? null : action.reminders_text,
        });
        const added = action.reminder_at?.length
          ? await setExactReminders(item, action.reminder_at, now, true)
          : [];
        return { done: `✏️ Изменил «${item.title}»${cleared}${exactNote(added)}` };
      } catch (error) {
        // An unclear reminder must not cancel the rest of the edit.
        if (!(error instanceof PlannerItemEditError) || error.code !== "reminders_not_understood") {
          throw error;
        }
        const { item, changed } = await editPlannerItemFromApp(edit);
        const added = await setExactReminders(
          item,
          timesOnItemDay(item, action.reminders_text, tz),
          now,
          true,
        );
        return {
          done:
            changed || added.length
              ? `✏️ Изменил «${item.title}»${cleared}${exactNote(added)}`
              : undefined,
          problem: added.length
            ? undefined
            : `Не понял напоминания «${action.reminders_text}» — их не менял`,
        };
      }
    }
    case "delete_item": {
      if (!action.item_id) throw new Error("не указано дело");
      const deleted = await deletePlannerItemEverywhere({
        userId: user.id,
        itemId: action.item_id,
        source: "jarvis_chat",
      });
      if (!deleted) throw new PlannerItemEditError("not_found");
      return { done: `🗑 Удалил «${deleted.item.title}»` };
    }
    case "complete_item": {
      if (!action.item_id) throw new Error("не указано дело");
      const result = await completePlannerItemFromApp({
        userId: user.id,
        itemId: action.item_id,
        timezone: tz,
      });
      if (result.outcome === "missing") throw new PlannerItemEditError("not_found");
      if (result.outcome === "needs_clarification") throw new Error("событие ещё впереди");
      return { done: `✔️ Отметил «${result.item.title}»` };
    }
    case "log_food": {
      if (!action.food_text) throw new FoodLogError("not_food_text");
      const { estimate } = await logFoodFromText({
        user,
        text: action.food_text,
        eatenAtLocal: action.eaten_at,
        capability: "food_estimation_jarvis",
      });
      return { done: `🍽 Записал: ${estimate.title} — ${estimate.calories} ккал` };
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
      return {
        done: `🏋️ Записал: ${logged.label}, ${action.duration_minutes} мин, ${logged.estimated ? "≈ " : ""}${logged.calories} ккал`,
      };
    }
  }
}

const VERBS: Record<JarvisAction["type"], string> = {
  create_item: "добавить",
  update_item: "изменить",
  delete_item: "удалить",
  complete_item: "отметить",
  log_food: "записать еду",
  log_workout: "записать тренировку",
};

const REASONS: Record<string, string> = {
  not_found: "не нашёл это дело — возможно, оно уже удалено или выполнено",
  reminders_not_understood: "не понял напоминания",
  time_required: "для встречи или тренировки нужно время начала",
  invalid_time: "не понял дату или время",
  not_food_text: "не понял, что съедено",
};

// What the owner reads when an action fails: plain words, not an internal code.
export function failureLine(action: JarvisAction, error: unknown, title?: string) {
  const code =
    error instanceof PlannerItemEditError ||
    error instanceof AppCreateError ||
    error instanceof FoodLogError
      ? error.code
      : null;
  const reason =
    (code && REASONS[code]) ?? (error instanceof Error ? error.message : String(error));
  const name = action.title ?? title;
  return `⚠️ Не получилось ${VERBS[action.type]}${name ? ` «${name}»` : ""}: ${reason}`;
}

// The visible answer: what really happened first, then the model's words. The model
// writes its reply before anything runs, so it must never be the only report.
export function composeJarvisAnswer(params: { reply: string; done: string[]; failed: string[] }) {
  const status = [...params.done, ...params.failed].join("\n");
  return [status, params.reply].filter(Boolean).join("\n\n") || "Готово.";
}

// The model writes its reply before anything runs; when something failed, the reply is
// rewritten against the real results so it never says "поставил", "исправил" untruthfully.
async function reconcileReply(reply: string, done: string[], failed: string[]) {
  if (!reply || !failed.length) return reply;
  try {
    const answer = await askClaudeRelay({
      system:
        "Ты редактор. Тебе дают черновик ответа ассистента и фактические результаты действий. Перепиши черновик так, чтобы в нём не было ничего, что противоречит результатам: не выдавай за сделанное то, что в списке «Не получилось», и не повторяй сами строки результатов — они уже стоят над ответом. Ничего нового не добавляй, полезные советы сохрани, стиль и язык оставь. Если после правки сказать нечего — верни пустой ответ. Верни только текст ответа.",
      prompt: `Черновик:\n${reply}\n\nСделано:\n${done.join("\n") || "—"}\n\nНе получилось:\n${failed.join("\n")}`,
      model: "sonnet",
      effort: "low",
      timeoutMs: RECONCILE_TIMEOUT_MS,
    });
    return answer.result?.trim() ?? "";
  } catch {
    return `${reply}\n\n⚠️ Если выше сказано, что всё сделано, — верны строки с ✅ и ⚠️ в начале ответа.`;
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
    const decision = await decide(user, now, history, {
      effort: "high",
      timeoutMs: CHAT_TIMEOUT_MS,
    });
    const done: string[] = [];
    const failed: string[] = [];
    for (const action of decision.actions) {
      try {
        const outcome = await execute(user, action, now);
        if (outcome.done) {
          done.push(outcome.done);
          changed = true;
        }
        if (outcome.problem) failed.push(`⚠️ ${outcome.problem}`);
      } catch (error) {
        failed.push(
          failureLine(
            action,
            error,
            action.item_id ? decision.titles.get(action.item_id) : undefined,
          ),
        );
      }
    }
    if (decision.invalid) failed.push("⚠️ Часть просьбы не разобрал — переформулируй, пожалуйста.");
    await insertCoachMessage({
      userId: user.id,
      role: "assistant",
      content: composeJarvisAnswer({
        reply: await reconcileReply(decision.reply, done, failed),
        done,
        failed,
      }),
      metadata: {
        engine: "claude",
        model: decision.model,
        durationMs: decision.durationMs,
        done,
        failed,
      },
    });
    await writeAudit({
      userId: user.id,
      action: "assistant.jarvis_turn",
      entityType: "coach",
      details: {
        model: decision.model,
        durationMs: decision.durationMs,
        actions: decision.actions,
        done,
        failed,
      },
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
    const history = [{ role: "user", content: text, createdAt: now, metadata: {} }];
    const decision = await decide(user, now, history, {
      effort: "medium",
      timeoutMs: SHADOW_TIMEOUT_MS,
    });
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
        durationMs: decision.durationMs,
      },
    });
  } catch (error) {
    logger.warn("JARVIS shadow decision failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
