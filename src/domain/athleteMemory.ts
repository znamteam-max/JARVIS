import { DateTime } from "luxon";

import type { CoachMemory, HealthItem, HealthRecord } from "@/db/schema";

// What the coach must never lose sight of, however long the chat: her own words about
// herself, and her lab results.

const FLAG_MARK: Record<string, string> = { low: " ↓", high: " ↑" };
const MAX_DETAILED_RECORDS = 10;

export function formatTakenOn(takenOn: string | null) {
  return takenOn ? DateTime.fromISO(takenOn).toFormat("dd.LL.yyyy") : "без даты";
}

export function formatHealthItem(item: HealthItem) {
  const value = [item.value, item.unit].filter(Boolean).join(" ");
  const reference = item.reference ? ` (норма ${item.reference})` : "";
  return `${item.name} ${value}${reference}${FLAG_MARK[item.flag] ?? ""}`;
}

// One fact per line, as stored: the coach copies a line back as is to "forget" it.
export function memoryBlock(memories: Pick<CoachMemory, "fact">[]) {
  const lines = memories.map((memory) => `- ${memory.fact}`);
  return [
    "## Что она рассказала о себе (помни всегда; её слова о себе важнее общих норм)",
    lines.length ? lines.join("\n") : "Пока ничего.",
  ].join("\n");
}

export function healthRecordsBlock(
  records: Pick<HealthRecord, "takenOn" | "lab" | "title" | "items" | "summary">[],
) {
  if (!records.length) return "## Анализы\nНе загружала.";
  const lines = records.map((record, index) => {
    const head = `- ${formatTakenOn(record.takenOn)} · ${record.title}${record.lab ? ` (${record.lab})` : ""}`;
    if (index >= MAX_DETAILED_RECORDS || !record.items.length) {
      return `${head}: ${record.summary}`;
    }
    return `${head}: ${record.items.map(formatHealthItem).join("; ")}`;
  });
  return [
    "## Анализы (её результаты, новые сверху; ↑/↓ — выше/ниже нормы лаборатории)",
    ...lines,
  ].join("\n");
}

// /analyses: what is stored, numbered for /analyses_delete.
export function healthRecordsList(records: Pick<HealthRecord, "takenOn" | "title" | "items">[]) {
  return records
    .map((record, index) => {
      const flagged = record.items.filter((item) => item.flag === "low" || item.flag === "high");
      const flags = flagged.length
        ? `; вне нормы: ${flagged.map((item) => `${item.name}${FLAG_MARK[item.flag]}`).join(", ")}`
        : "";
      return `${index + 1}. ${formatTakenOn(record.takenOn)} — ${record.title} (${record.items.length} показ.${flags})`;
    })
    .join("\n");
}
