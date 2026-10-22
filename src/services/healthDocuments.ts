import { and, desc, eq, gte, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";

import { askClaudeJson, type ClaudeContent } from "@/ai/anthropicClient";
import { getDb } from "@/db/client";
import { insertCoachMessage } from "@/db/queries/coach";
import { healthRecords, type HealthItem, type User } from "@/db/schema";

// A photo or PDF of lab results becomes a dated record the coach always sees. Screenshots
// of one long result arrive one by one: parts of the same test sent minutes apart merge.

export const SUPPORTED_HEALTH_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
type SupportedType = (typeof SUPPORTED_HEALTH_TYPES)[number];

const MERGE_WINDOW_MS = 15 * 60 * 1000;

const READ_INSTRUCTIONS = `Ты читаешь медицинский документ спортсменки — фото или PDF результатов анализов. Перепиши показатели точно как в документе: название, результат, единицы, норма лаборатории. flag: low или high — если результат вне нормы лаборатории или лаборатория пометила отклонение; normal — в норме; unknown — если нормы нет. taken_on — дата исследования в формате YYYY-MM-DD или пустая строка. lab — лаборатория или клиника, или пустая строка. title — короткое название, например «Клинический анализ крови» или «Железо и ферритин». summary — 2–4 предложения простыми словами: что вне нормы и что это может значить для тренировок на выносливость; без диагнозов; при заметных отклонениях — совет обсудить с врачом. Персональные данные (ФИО, номер полиса, адрес, телефон) никуда не переписывай. Если это не результаты анализов — is_lab_result: false, остальное пустое.`;

const HEALTH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_lab_result", "taken_on", "lab", "title", "items", "summary"],
  properties: {
    is_lab_result: { type: "boolean" },
    taken_on: { type: "string" },
    lab: { type: "string" },
    title: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value", "unit", "reference", "flag"],
        properties: {
          name: { type: "string" },
          value: { type: "string" },
          unit: { type: "string" },
          reference: { type: "string" },
          flag: { type: "string", enum: ["low", "high", "normal", "unknown"] },
        },
      },
    },
    summary: { type: "string" },
  },
};

// Long texts are cut, never a reason to lose the whole document.
const cut = (length: number) => z.string().transform((text) => text.trim().slice(0, length));

const resultSchema = z.object({
  is_lab_result: z.boolean(),
  taken_on: z.string(),
  lab: cut(200),
  title: cut(120),
  items: z.array(
    z.object({
      name: cut(200),
      value: cut(120),
      unit: cut(60),
      reference: cut(400),
      flag: z.enum(["low", "high", "normal", "unknown"]).catch("unknown"),
    }),
  ),
  summary: cut(2000),
});

export function validLabDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid ? value : null;
}

export function isSupportedHealthType(
  mediaType: string | null | undefined,
): mediaType is SupportedType {
  return SUPPORTED_HEALTH_TYPES.includes(mediaType as SupportedType);
}

export async function readHealthDocument(params: {
  bytes: Uint8Array;
  mediaType: SupportedType;
  caption?: string | null;
}) {
  const data = Buffer.from(params.bytes).toString("base64");
  const file: ClaudeContent =
    params.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: params.mediaType, data } };
  const { data: raw, model } = await askClaudeJson<unknown>({
    system: [{ text: READ_INSTRUCTIONS }],
    content: [
      file,
      {
        type: "text",
        text: params.caption ? `Её подпись к файлу: ${params.caption}` : "Прочитай документ.",
      },
    ],
    schema: HEALTH_SCHEMA,
    effort: "medium",
    timeoutMs: 100_000,
  });
  const result = resultSchema.parse(raw);
  const items = result.items.filter((item) => item.name) as HealthItem[];
  return {
    isLabResult: result.is_lab_result && items.length > 0,
    takenOn: validLabDate(result.taken_on),
    lab: result.lab || null,
    title: result.title || "Анализы",
    items,
    summary: result.summary.trim(),
    model,
  };
}

// Parts of one result sent a few minutes apart are one record; a line seen twice is kept once.
export function mergeHealthItems(current: HealthItem[], added: HealthItem[]) {
  const key = (item: HealthItem) => `${item.name.toLowerCase()}|${item.unit.toLowerCase()}`;
  const seen = new Set(current.map(key));
  return [...current, ...added.filter((item) => !seen.has(key(item)))];
}

// A new part continues the record she sent just before when the dates agree (or this part
// has no date of its own): the model may name the same test a little differently.
export function continuesRecord(
  recent: { takenOn: string | null },
  part: { takenOn: string | null },
) {
  return !part.takenOn || recent.takenOn === part.takenOn;
}

export async function saveHealthDocument(params: {
  user: User;
  result: Awaited<ReturnType<typeof readHealthDocument>>;
  now?: Date;
}) {
  const { user, result } = params;
  const now = params.now ?? new Date();
  // Photos of an album arrive in parallel: one at a time per person, so no part is lost.
  const saved = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`health:${user.id}`}))`);
    const [recent] = await tx
      .select()
      .from(healthRecords)
      .where(
        and(
          eq(healthRecords.userId, user.id),
          eq(healthRecords.source, "upload"),
          gte(healthRecords.updatedAt, new Date(now.getTime() - MERGE_WINDOW_MS)),
        ),
      )
      .orderBy(desc(healthRecords.updatedAt))
      .limit(1);
    if (recent && continuesRecord(recent, result)) {
      const [record] = await tx
        .update(healthRecords)
        .set({
          // Several tests of one blood draw sent together: the title names them all.
          title: recent.title.toLowerCase().includes(result.title.toLowerCase())
            ? recent.title
            : `${recent.title}; ${result.title}`.slice(0, 200),
          items: mergeHealthItems(recent.items, result.items),
          summary: result.summary || recent.summary,
          updatedAt: now,
        })
        .where(eq(healthRecords.id, recent.id))
        .returning();
      return { record, merged: true };
    }
    const [record] = await tx
      .insert(healthRecords)
      .values({
        userId: user.id,
        takenOn: result.takenOn,
        lab: result.lab,
        title: result.title,
        items: result.items,
        summary: result.summary,
        source: "upload",
      })
      .returning();
    return { record, merged: false };
  });
  if (saved.merged) return saved;
  const { record } = saved;
  // In the chat too, so a follow-up question («а ферритин нормальный?») has its context.
  await insertCoachMessage({
    userId: user.id,
    role: "user",
    content: `🧪 Прислала анализы: ${result.title}${result.takenOn ? ` от ${result.takenOn}` : ""}`,
    metadata: { healthRecordId: record.id },
  });
  await insertCoachMessage({
    userId: user.id,
    role: "assistant",
    content: result.summary,
    metadata: { engine: "anthropic", model: result.model, healthRecordId: record.id },
  });
  return { record, merged: false };
}
