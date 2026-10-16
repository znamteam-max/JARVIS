import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  cancelPlannerItem: vi.fn(),
  cancelItemReminders: vi.fn(),
  stopPoliciesForItem: vi.fn(),
  cancelCalendarSyncJobsForItem: vi.fn(),
  getItemCalendarSyncState: vi.fn(),
  markGoogleCalendarSync: vi.fn(),
  deleteYandexCalendarObject: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/db/queries/items", () => ({
  cancelPlannerItem: calls.cancelPlannerItem,
  cancelCalendarSyncJobsForItem: calls.cancelCalendarSyncJobsForItem,
}));
vi.mock("@/db/queries/reminders", () => ({ cancelItemReminders: calls.cancelItemReminders }));
vi.mock("@/db/queries/reminderPolicies", () => ({
  stopPoliciesForItem: calls.stopPoliciesForItem,
}));
vi.mock("@/db/queries/googleCalendar", () => ({
  getItemCalendarSyncState: calls.getItemCalendarSyncState,
  markGoogleCalendarSync: calls.markGoogleCalendarSync,
}));
vi.mock("@/integrations/yandexCalendar", () => ({
  deleteYandexCalendarObject: calls.deleteYandexCalendarObject,
}));
vi.mock("@/db/queries/audit", () => ({ writeAudit: calls.writeAudit }));

import { deletePlannerItemEverywhere } from "@/services/plannerItemDelete";

const ITEM = { id: "item-1", kind: "event", title: "Фотосессия" };
const HREF = "https://caldav.yandex.ru/calendars/x/events/abc.ics";

describe("deleting a schedule item from the app or the bot", () => {
  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockReset();
    calls.cancelPlannerItem.mockResolvedValue(ITEM);
    calls.writeAudit.mockResolvedValue(undefined);
    calls.markGoogleCalendarSync.mockResolvedValue(undefined);
  });

  it("removes the item, its reminders, rules and its Yandex event", async () => {
    calls.getItemCalendarSyncState.mockResolvedValue({ externalId: HREF, status: "synced" });
    calls.deleteYandexCalendarObject.mockResolvedValue(undefined);

    const result = await deletePlannerItemEverywhere({
      userId: "u",
      itemId: "item-1",
      source: "miniapp_delete",
    });

    expect(result).toEqual({ item: ITEM, calendarDeleted: true });
    expect(calls.cancelItemReminders).toHaveBeenCalledWith("u", "item-1");
    expect(calls.stopPoliciesForItem).toHaveBeenCalledWith("u", "item-1");
    expect(calls.cancelCalendarSyncJobsForItem).toHaveBeenCalledWith("item-1");
    expect(calls.deleteYandexCalendarObject).toHaveBeenCalledWith(HREF);
    expect(calls.markGoogleCalendarSync).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: null, status: "not_synced" }),
    );
  });

  it("still deletes the item when Yandex is down, and keeps the event recognisable", async () => {
    calls.getItemCalendarSyncState.mockResolvedValue({ externalId: HREF, status: "synced" });
    calls.deleteYandexCalendarObject.mockRejectedValue(new Error("caldav timeout"));

    const result = await deletePlannerItemEverywhere({
      userId: "u",
      itemId: "item-1",
      source: "t",
    });

    expect(result?.calendarDeleted).toBe(false);
    expect(calls.cancelItemReminders).toHaveBeenCalled();
    expect(calls.markGoogleCalendarSync).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: HREF, status: "disabled", lastError: "delete_failed" }),
    );
  });

  it("leaves the calendar alone for items that were never synced", async () => {
    calls.getItemCalendarSyncState.mockResolvedValue(null);
    await deletePlannerItemEverywhere({ userId: "u", itemId: "item-1", source: "t" });
    expect(calls.deleteYandexCalendarObject).not.toHaveBeenCalled();
    expect(calls.markGoogleCalendarSync).not.toHaveBeenCalled();
  });

  it("reports a missing item without touching anything else", async () => {
    calls.cancelPlannerItem.mockResolvedValue(null);
    const result = await deletePlannerItemEverywhere({ userId: "u", itemId: "nope", source: "t" });
    expect(result).toBeNull();
    expect(calls.cancelItemReminders).not.toHaveBeenCalled();
    expect(calls.getItemCalendarSyncState).not.toHaveBeenCalled();
  });
});
