import { NextResponse } from "next/server";
import { z } from "zod";

import { getPlannerItemById } from "@/db/queries/items";
import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import { syncItemsToCalendarBestEffort } from "@/services/calendarBestEffort";
import {
  applyItemEditMutation,
  parseItemEditMutation,
  type ItemEditMutation,
} from "@/services/itemEditMutations";
import { buildMiniAppSummary } from "@/services/miniappSummary";

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
  const item = await getPlannerItemById(owner.id, body.data.id);
  if (!item) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const edit = body.data;
  const mutation: ItemEditMutation = {
    itemId: item.id,
    changedFields: [],
    warnings: [],
    pastConfirmationRequired: false,
  };
  if (edit.title && edit.title !== item.title) {
    mutation.title = edit.title;
    mutation.changedFields.push("title");
  }
  if (edit.startLocal) {
    mutation.scheduledForLocal = `${edit.startLocal}:00`;
    if (edit.endLocal && edit.endLocal > edit.startLocal)
      mutation.endsAtLocal = `${edit.endLocal}:00`;
    mutation.changedFields.push("schedule");
  }
  if (edit.dueLocal === null && item.dueAt) {
    mutation.clearDeadline = true;
    mutation.changedFields.push("deadline");
  } else if (edit.dueLocal) {
    mutation.deadlineAtLocal = `${edit.dueLocal}:00`;
    mutation.changedFields.push("deadline");
  }
  if (edit.remindersText) {
    const parsed = parseItemEditMutation({
      text: edit.remindersText,
      item,
      timezone: owner.timezone,
    }).reminderPolicy;
    if (!parsed) {
      return NextResponse.json({ ok: false, error: "reminders_not_understood" }, { status: 400 });
    }
    // A reminder typed in the form replaces the old before-event set instead of asking.
    mutation.reminderPolicy =
      parsed.policyType === "before_event_multi" && parsed.mode === "ask"
        ? { ...parsed, mode: "replace" }
        : parsed;
    mutation.changedFields.push("reminder_policy");
  }

  if (mutation.changedFields.length) {
    const result = await applyItemEditMutation({
      userId: owner.id,
      item,
      mutation,
      timezone: owner.timezone,
    });
    if (result.item) await syncItemsToCalendarBestEffort([result.item]).catch(() => []);
  }
  return NextResponse.json({ ok: true, summary: await buildMiniAppSummary(owner) });
}
