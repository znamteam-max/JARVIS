import { writeAudit } from "@/db/queries/audit";
import { getItemCalendarSyncState, markGoogleCalendarSync } from "@/db/queries/googleCalendar";
import { cancelCalendarSyncJobsForItem, cancelPlannerItem } from "@/db/queries/items";
import { stopPoliciesForItem } from "@/db/queries/reminderPolicies";
import { cancelItemReminders } from "@/db/queries/reminders";
import { deleteYandexCalendarObject } from "@/integrations/yandexCalendar";
import { logger } from "@/lib/logger";

const YANDEX_PROVIDER = "yandex_calendar";

// "Удалить" = the item, its reminders and rules, and its copy in Yandex Calendar.
// The calendar part is best effort: a CalDAV hiccup must not keep the item alive.
export async function deletePlannerItemEverywhere(params: {
  userId: string;
  itemId: string;
  source: string;
}) {
  const item = await cancelPlannerItem(params.userId, params.itemId);
  if (!item) return null;
  await cancelItemReminders(params.userId, item.id);
  await stopPoliciesForItem(params.userId, item.id);
  await cancelCalendarSyncJobsForItem(item.id);

  let calendarDeleted = false;
  const sync = await getItemCalendarSyncState(item.id, YANDEX_PROVIDER).catch(() => null);
  if (sync?.externalId && sync.status !== "disabled") {
    try {
      await deleteYandexCalendarObject(sync.externalId);
      calendarDeleted = true;
    } catch (error) {
      logger.warn("Yandex event delete failed", {
        itemId: item.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Gone from Yandex: forget the href, so an undo would create a fresh event. If the delete
    // failed, keep the href so the calendar import still recognises the event as ours.
    await markGoogleCalendarSync({
      item,
      externalId: calendarDeleted ? null : sync.externalId,
      status: calendarDeleted ? "not_synced" : "disabled",
      lastError: calendarDeleted ? null : "delete_failed",
      provider: YANDEX_PROVIDER,
    }).catch(() => undefined);
  }

  await writeAudit({
    userId: params.userId,
    action: "assistant.planner_mutation",
    entityType: "planner_item",
    entityId: item.id,
    details: { mutationSource: params.source, operation: "cancel", calendarDeleted },
  }).catch(() => undefined);
  return { item, calendarDeleted };
}
