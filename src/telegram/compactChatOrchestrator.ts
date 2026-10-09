import { listActiveMessages } from "@/db/queries/telegramMessageRegistry";
import { deleteMessagesSafe, registerBotMessage } from "@/telegram/messageLifecycle";
import {
  sendOrRefreshLiveDashboard,
  type LiveDashboardTelegramApi,
} from "@/telegram/liveDashboard";

export type CompactActiveReminder = {
  text: string;
  options?: Record<string, unknown>;
  relatedItemId?: string | null;
  relatedReminderId?: string | null;
};

export async function syncCompactChat(params: {
  userId: string;
  chatId: string;
  timezone: string;
  reason: string;
  activeReminder?: CompactActiveReminder | null;
  now?: Date;
  api: LiveDashboardTelegramApi;
}) {
  const oldReminderCards = await listActiveMessages({
    userId: params.userId,
    chatId: params.chatId,
    purposes: ["active_reminder", "reminder", "followup"],
  });
  await deleteMessagesSafe({
    chatId: params.chatId,
    messageIds: oldReminderCards.map((message) => message.messageId),
    api: params.api,
  });

  const dashboard = await sendOrRefreshLiveDashboard({
    userId: params.userId,
    chatId: params.chatId,
    timezone: params.timezone,
    now: params.now,
    api: params.api,
    skipIfUnchanged: true,
  });
  if (!params.activeReminder) return { dashboard, reminderMessageId: null };

  const sent = await params.api.sendMessage(
    params.chatId,
    params.activeReminder.text,
    params.activeReminder.options,
  );
  await registerBotMessage({
    userId: params.userId,
    chatId: params.chatId,
    messageId: sent.message_id,
    purpose: "active_reminder",
    relatedItemId: params.activeReminder.relatedItemId,
    relatedReminderId: params.activeReminder.relatedReminderId,
    metadata: { reason: params.reason },
  });
  return { dashboard, reminderMessageId: sent.message_id };
}
