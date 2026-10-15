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
