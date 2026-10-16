import { DateTime } from "luxon";
import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import { buildMiniAppSummary } from "@/services/miniappSummary";
import {
  AppCreateError,
  createPlannerItemFromApp,
  REMINDER_CHOICES,
  type ReminderChoice,
} from "@/services/miniappCreate";
import { completePlannerItemFromApp } from "@/services/plannerItemComplete";
import { deletePlannerItemEverywhere } from "@/services/plannerItemDelete";
import { editPlannerItemFromApp, PlannerItemEditError } from "@/services/plannerItemEdit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

const editSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(300).optional(),
  startLocal: localDateTime.nullable().optional(),
  endLocal: localDateTime.nullable().optional(),
  dueLocal: localDateTime.nullable().optional(),
  remindersText: z.string().trim().max(300).optional(),
});

// The same mutation pipeline as the bot's "Изменить" flow, fed from form fields.
export async function PATCH(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = editSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  try {
    await editPlannerItemFromApp({
      user: owner,
      itemId: body.data.id,
      title: body.data.title,
      startLocal: body.data.startLocal,
      endLocal: body.data.endLocal,
      dueLocal: body.data.dueLocal,
      remindersText: body.data.remindersText,
    });
  } catch (error) {
    if (error instanceof PlannerItemEditError) {
      return NextResponse.json(
        { ok: false, error: error.code },
        { status: error.code === "not_found" ? 404 : 400 },
      );
    }
    throw error;
  }
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}

// Same as the bot's "Удалить": the item goes with its reminders, rules and calendar copy.
export async function DELETE(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  const deleted = await deletePlannerItemEverywhere({
    userId: owner.id,
    itemId: id,
    source: "miniapp_delete",
  });
  if (!deleted) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({
    ok: true,
    message: `Удалил «${deleted.item.title}».`,
    summary: await buildMiniAppSummary(owner),
  });
}

const doneSchema = z.object({ id: z.string().uuid(), action: z.literal("done") });

const createSchema = z.object({
  action: z.literal("create"),
  kind: z.enum(["task", "event", "training"]),
  title: z.string().trim().min(1).max(300),
  dateLocal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  timeLocal: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  reminders: z
    .array(z.enum(Object.keys(REMINDER_CHOICES) as [ReminderChoice, ...ReminderChoice[]]))
    .max(5),
  remindersText: z.string().trim().max(300).nullable().optional(),
});

// "Сделал" (a recurring task closes only this round) or "Добавить" from the home screen.
export async function POST(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const raw: unknown = await request.json().catch(() => null);
  const create = createSchema.safeParse(raw);
  if (create.success) {
    try {
      const { item, extraUnderstood } = await createPlannerItemFromApp({
        user: owner,
        ...create.data,
      });
      const when = item.startAt ?? item.dueAt;
      const whenText = when
        ? ` — ${DateTime.fromJSDate(when, { zone: "utc" })
            .setZone(owner.timezone)
            .setLocale("ru")
            .toFormat("ccc d MMMM, HH:mm")}`
        : "";
      const warning =
        extraUnderstood === false ? " Своё напоминание не понял — поправь в «Изменить»." : "";
      return NextResponse.json({
        ok: true,
        message: `Добавил «${item.title}»${whenText}.${warning}`,
        summary: await buildMiniAppSummary(owner),
      });
    } catch (error) {
      if (error instanceof AppCreateError) {
        return NextResponse.json({ ok: false, error: error.code }, { status: 400 });
      }
      throw error;
    }
  }
  const body = doneSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  const result = await completePlannerItemFromApp({
    userId: owner.id,
    itemId: body.data.id,
    timezone: owner.timezone,
  });
  if (result.outcome === "missing") {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (result.outcome === "needs_clarification") {
    return NextResponse.json({ ok: false, error: "done_needs_bot" }, { status: 409 });
  }
  const next =
    result.outcome === "occurrence" && result.nextFireAt
      ? DateTime.fromISO(result.nextFireAt, { zone: "utc" })
          .setZone(owner.timezone)
          .setLocale("ru")
          .toFormat("ccc d MMMM, HH:mm")
      : null;
  const message =
    result.outcome === "occurrence"
      ? `Отметил этот раз «${result.item.title}».${next ? ` Следующий — ${next}.` : ""}`
      : `Готово: «${result.item.title}».`;
  return NextResponse.json({ ok: true, message, summary: await buildMiniAppSummary(owner) });
}
