import { getPlannerItemById } from "@/db/queries/items";
import type { User } from "@/db/schema";
import { syncItemsToCalendarBestEffort } from "@/services/calendarBestEffort";
import {
  applyItemEditMutation,
  parseItemEditMutation,
  type ItemEditMutation,
} from "@/services/itemEditMutations";

export class PlannerItemEditError extends Error {
  constructor(readonly code: "not_found" | "reminders_not_understood") {
    super(code);
  }
}

// One edit path for the app's form and for JARVIS: the bot's own mutation pipeline,
// fed from fields. Local times are "yyyy-MM-ddTHH:mm" in the owner's timezone.
export async function editPlannerItemFromApp(params: {
  user: User;
  itemId: string;
  title?: string | null;
  startLocal?: string | null;
  endLocal?: string | null;
  dueLocal?: string | null;
  clearDeadline?: boolean;
  remindersText?: string | null;
}) {
  const { user } = params;
  const item = await getPlannerItemById(user.id, params.itemId);
  if (!item || item.status !== "active") throw new PlannerItemEditError("not_found");

  const mutation: ItemEditMutation = {
    itemId: item.id,
    changedFields: [],
    warnings: [],
    pastConfirmationRequired: false,
  };
  if (params.title && params.title !== item.title) {
    mutation.title = params.title;
    mutation.changedFields.push("title");
  }
  if (params.startLocal) {
    mutation.scheduledForLocal = `${params.startLocal}:00`;
    if (params.endLocal && params.endLocal > params.startLocal) {
      mutation.endsAtLocal = `${params.endLocal}:00`;
    }
    mutation.changedFields.push("schedule");
  }
  if ((params.clearDeadline || params.dueLocal === null) && item.dueAt) {
    mutation.clearDeadline = true;
    mutation.changedFields.push("deadline");
  } else if (params.dueLocal) {
    mutation.deadlineAtLocal = `${params.dueLocal}:00`;
    mutation.changedFields.push("deadline");
  }
  if (params.remindersText?.trim()) {
    const parsed = parseItemEditMutation({
      text: params.remindersText,
      item,
      timezone: user.timezone,
    }).reminderPolicy;
    if (!parsed) throw new PlannerItemEditError("reminders_not_understood");
    // A reminder given as a new instruction replaces the old before-event set.
    mutation.reminderPolicy =
      parsed.policyType === "before_event_multi" && parsed.mode === "ask"
        ? { ...parsed, mode: "replace" }
        : parsed;
    mutation.changedFields.push("reminder_policy");
  }

  if (!mutation.changedFields.length) return { item, changed: false };
  const result = await applyItemEditMutation({
    userId: user.id,
    item,
    mutation,
    timezone: user.timezone,
  });
  if (result.item) await syncItemsToCalendarBestEffort([result.item]).catch(() => []);
  return { item: result.item ?? item, changed: true };
}
