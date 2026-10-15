import { DateTime } from "luxon";
import { z } from "zod";

export type FoodConfidence = "low" | "medium" | "high";

export type FoodItemEstimate = {
  name: string;
  grams: number | null;
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
};

export type FoodEstimate = {
  isFood: boolean;
  title: string;
  items: FoodItemEstimate[];
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  confidence: FoodConfidence;
  note: string | null;
};

export type FoodMacros = { calories: number; proteinG: number; fatG: number; carbsG: number };

export type FoodDayEntry = FoodMacros & { title: string; eatenAt: Date };

const nonNegative = z.coerce
  .number()
  .catch(0)
  .transform((value) => Math.max(0, value));

const rawFoodEstimateSchema = z.object({
  isFood: z.boolean().catch(true),
  title: z.string().catch(""),
  items: z
    .array(
      z.object({
        name: z.string().catch(""),
        grams: z.coerce.number().nullable().catch(null),
        calories: nonNegative,
        proteinG: nonNegative,
        fatG: nonNegative,
        carbsG: nonNegative,
      }),
    )
    .catch([]),
  calories: nonNegative,
  proteinG: nonNegative,
  fatG: nonNegative,
  carbsG: nonNegative,
  confidence: z.enum(["low", "medium", "high"]).catch("low"),
  note: z.string().nullable().catch(null),
});

// The model's per-item numbers are what the user sees as bullets, so the total is
// always their sum; a separately reported total that disagrees would look like a bug.
export function normalizeFoodEstimate(raw: unknown): FoodEstimate {
  const parsed = rawFoodEstimateSchema.parse(raw ?? {});
  const items = parsed.items
    .filter((item) => item.name.trim())
    .map((item) => ({
      name: item.name.trim(),
      grams: item.grams && item.grams > 0 ? Math.round(item.grams) : null,
      calories: Math.round(item.calories),
      proteinG: Math.round(item.proteinG),
      fatG: Math.round(item.fatG),
      carbsG: Math.round(item.carbsG),
    }));
  const totals = items.length
    ? sumFoodMacros(items)
    : {
        calories: Math.round(parsed.calories),
        proteinG: Math.round(parsed.proteinG),
        fatG: Math.round(parsed.fatG),
        carbsG: Math.round(parsed.carbsG),
      };
  const title = parsed.title.trim() || items.map((item) => item.name).join(", ") || "Еда";
  return {
    isFood: parsed.isFood && (totals.calories > 0 || items.length > 0),
    title: title.charAt(0).toLocaleUpperCase("ru") + title.slice(1),
    items,
    ...totals,
    confidence: parsed.confidence,
    note: parsed.note?.trim() || null,
  };
}

export function sumFoodMacros(entries: FoodMacros[]): FoodMacros {
  return entries.reduce(
    (sum, entry) => ({
      calories: sum.calories + entry.calories,
      proteinG: sum.proteinG + entry.proteinG,
      fatG: sum.fatG + entry.fatG,
      carbsG: sum.carbsG + entry.carbsG,
    }),
    { calories: 0, proteinG: 0, fatG: 0, carbsG: 0 },
  );
}

export function formatFoodEstimateReply(params: {
  estimate: FoodEstimate;
  dayTotals: FoodMacros;
  dayCount: number;
}) {
  const { estimate } = params;
  if (!estimate.isFood) {
    return "Не вижу на фото еды. Если это еда — пришли фото с подписью, например: «гречка с курицей, 300 г».";
  }
  const lines = [`🍽 ${estimate.title}`, `≈ ${formatMacros(estimate)}`];
  for (const item of estimate.items) {
    const grams = item.grams ? ` ~${item.grams} г` : "";
    lines.push(`• ${item.name}${grams} — ${formatNumber(item.calories)} ккал`);
  }
  if (estimate.note) lines.push("", `ℹ️ ${estimate.note}`);
  lines.push(
    "",
    `Оценка примерная (уверенность: ${CONFIDENCE_LABELS[estimate.confidence]}). Если ошибся — удали запись и пришли фото с подписью.`,
    "",
    `За сегодня: ${formatMacros(params.dayTotals)} (${formatMeals(params.dayCount)})`,
  );
  return lines.join("\n");
}

export function formatFoodDaySummary(params: {
  entries: FoodDayEntry[];
  timezone: string;
  now: Date;
}) {
  const day = DateTime.fromJSDate(params.now, { zone: "utc" }).setZone(params.timezone);
  if (!params.entries.length) {
    return `🍽 Еда за ${day.toFormat("dd.LL")}: записей пока нет.\nПришли фото блюда (можно с подписью) — посчитаю калории.`;
  }
  const lines = [`🍽 Еда за ${day.toFormat("dd.LL")}`];
  for (const entry of params.entries) {
    const time = DateTime.fromJSDate(entry.eatenAt, { zone: "utc" })
      .setZone(params.timezone)
      .toFormat("HH:mm");
    lines.push(`• ${time} ${entry.title} — ${formatNumber(entry.calories)} ккал`);
  }
  lines.push("", `Итого: ${formatMacros(sumFoodMacros(params.entries))}`);
  return lines.join("\n");
}

const CONFIDENCE_LABELS: Record<FoodConfidence, string> = {
  low: "низкая",
  medium: "средняя",
  high: "высокая",
};

function formatMacros(macros: FoodMacros) {
  return `${formatNumber(macros.calories)} ккал · Б ${macros.proteinG} · Ж ${macros.fatG} · У ${macros.carbsG}`;
}

function formatNumber(value: number) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatMeals(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} приём`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} приёма`;
  return `${count} приёмов`;
}

const CORRECTION_FILLER = new Set(["было", "там", "где", "примерно", "грамм", "граммов", "гр"]);

// "лаваш 50 г", "курицы 200 гр", "убери овощи": exact edits the user can expect to be
// applied literally, by scaling the item. Anything vaguer returns null and goes to the AI.
export function applySimpleFoodCorrections(
  estimate: FoodEstimate,
  text: string,
): FoodEstimate | null {
  const clauses = text
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .split(/[,;\n]|\s+и\s+/)
    .map((clause) => clause.trim().replace(/[.!]+$/, ""))
    .filter(Boolean);
  if (!clauses.length) return null;
  const items = [...estimate.items];
  for (const clause of clauses) {
    const removal = clause.match(/^(?:убери|убрать|удали|без)\s+(.+)$/);
    if (removal) {
      const index = findFoodItem(items, removal[1]);
      if (index < 0) return null;
      items.splice(index, 1);
      continue;
    }
    const grams = clause.match(/^(.+?)\s*[-—:]?\s*(\d+(?:[.,]\d+)?)\s*(?:г|гр|грамм[а-я]*)?$/);
    if (!grams) return null;
    const index = findFoodItem(items, grams[1]);
    const value = Number(grams[2].replace(",", "."));
    const item = items[index];
    if (!item?.grams || !(value > 0)) return null;
    const factor = value / item.grams;
    items[index] = {
      ...item,
      grams: Math.round(value),
      calories: Math.round(item.calories * factor),
      proteinG: Math.round(item.proteinG * factor),
      fatG: Math.round(item.fatG * factor),
      carbsG: Math.round(item.carbsG * factor),
    };
  }
  if (!items.length) return null;
  return { ...estimate, items, ...sumFoodMacros(items) };
}

function findFoodItem(items: FoodItemEstimate[], phrase: string) {
  const stems = phrase
    .split(/[^а-яa-z]+/)
    .filter((word) => word.length >= 3 && !CORRECTION_FILLER.has(word))
    .map((word) => word.slice(0, 4));
  if (!stems.length) return -1;
  const matches = items
    .map((item, index) => ({
      index,
      words: item.name
        .toLocaleLowerCase("ru")
        .replace(/ё/g, "е")
        .split(/[^а-яa-z]+/)
        .filter(Boolean)
        .map((word) => word.slice(0, 4)),
    }))
    .filter(({ words }) => stems.every((stem) => words.includes(stem)));
  return matches.length === 1 ? matches[0].index : -1;
}
