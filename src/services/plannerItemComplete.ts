import { writeAudit } from "@/db/queries/audit";
import { getPlannerItemById, markPlannerItemCompleted } from "@/db/queries/items";
import { stopPoliciesForItem } from "@/db/queries/reminderPolicies";
import { cancelItemReminders } from "@/db/queries/reminders";
import { requiresCampaignCompletionClarification } from "@/services/campaignLifecycle";
import { cancelPendingPromptRenagsForTarget } from "@/services/pendingPromptRenag";
import { completePersistentRecurringItemCycle } from "@/services/recurringOccurrenceCompletion";

// The bot's "✅ Сделал" for the Mini App: a weekly/monthly task closes only this round
// (the rule stays for the next one); anything else is completed with its reminders.
export async function completePlannerItemFromApp(params: {
  userId: string;
  itemId: string;
  timezone: string;
}) {
  const cycle = await completePersistentRecurringItemCycle(params);
  if (cycle.handled) {
    const next = cycle.nextOccurrences
      .map((occurrence) => occurrence.nextFireAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0];
    return { outcome: "occurrence" as const, item: cycle.item, nextFireAt: next ?? null };
  }

  const existing = await getPlannerItemById(params.userId, params.itemId);
  if (!existing || existing.status !== "active") return { outcome: "missing" as const };
  if (requiresCampaignCompletionClarification(existing)) {
    return { outcome: "needs_clarification" as const, item: existing };
  }
  const item = await markPlannerItemCompleted(params.userId, existing.id);
  if (!item) return { outcome: "missing" as const };
  await cancelItemReminders(params.userId, item.id);
  await stopPoliciesForItem(params.userId, item.id);
  await cancelPendingPromptRenagsForTarget({
    userId: params.userId,
    targetItemId: item.id,
    reason: "item_completed",
  }).catch(() => undefined);
  await writeAudit({
    userId: params.userId,
    action: "assistant.planner_mutation",
    entityType: "planner_item",
    entityId: item.id,
    details: { mutationSource: "miniapp_done", operation: "complete" },
  }).catch(() => undefined);
  return { outcome: "completed" as const, item };
}
