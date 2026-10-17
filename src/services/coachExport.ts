import { DateTime } from "luxon";

import { listAllCoachMessages } from "@/db/queries/coach";
import type { CoachMessage, User } from "@/db/schema";
import { chatModelLabel } from "@/domain/chatModelLabel";

// The whole JARVIS chat as Markdown: every message with its local time, who wrote it
// (and which model), what was actually done, and where "Новый разговор" started a thread.
export function formatCoachChatExport(params: {
  messages: Array<
    Pick<CoachMessage, "role" | "content" | "status" | "metadata" | "createdAt" | "updatedAt">
  >;
  timezone: string;
  now: Date;
}) {
  const local = (date: Date) =>
    DateTime.fromJSDate(date, { zone: "utc" }).setZone(params.timezone).setLocale("ru");
  const lines = [
    "# JARVIS — история чата",
    "",
    `Выгружено: ${local(params.now).toFormat("d MMMM yyyy, HH:mm")} (${params.timezone}). Сообщений: ${params.messages.length}.`,
  ];
  // "Новый разговор" archives a whole thread at once, so its messages share updatedAt.
  let thread: string | null = null;
  for (const message of params.messages) {
    const key =
      message.status === "archived" ? `archived:${message.updatedAt.toISOString()}` : "active";
    if (key !== thread) {
      thread = key;
      lines.push(
        "",
        "---",
        "",
        key === "active" ? "## Текущий разговор" : "## Разговор (закрыт кнопкой «Новый разговор»)",
      );
    }
    const metadata = message.metadata ?? {};
    const who =
      metadata.auto === true
        ? "Система — новые тренировки"
        : message.role === "assistant"
          ? `JARVIS · ${chatModelLabel(metadata) ?? "модель не записана"}`
          : "Вы";
    lines.push("", `### ${local(message.createdAt).toFormat("ccc dd.LL.yyyy HH:mm")} — ${who}`, "");
    lines.push(message.content.trim());
    const done = Array.isArray(metadata.done) ? (metadata.done as string[]) : [];
    const failed = Array.isArray(metadata.failed) ? (metadata.failed as string[]) : [];
    // Earlier answers kept the action results only in metadata.
    const missing = [...done, ...failed].filter((line) => !message.content.includes(line));
    if (missing.length) lines.push("", "Действия:", ...missing.map((line) => `- ${line}`));
  }
  return `${lines.join("\n")}\n`;
}

export async function buildCoachChatExport(user: User, now = new Date()) {
  const messages = await listAllCoachMessages(user.id);
  const date = DateTime.fromJSDate(now, { zone: "utc" }).setZone(user.timezone).toISODate();
  return {
    fileName: `jarvis-chat-${date}.md`,
    text: formatCoachChatExport({ messages, timezone: user.timezone, now }),
  };
}
