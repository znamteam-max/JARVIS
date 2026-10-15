import { sumFoodMacros, type FoodItemEstimate, type FoodMacros } from "@/domain/foodEstimate";

export type PlanRow = { number: number; text: string; details: string[] };
export type PlanSection = { title: string; rows: PlanRow[]; note: string | null };

// The bot's "JARVIS · План" message is the single source of truth for the schedule;
// the Mini App shows exactly the same sections instead of re-deriving them.
export function parsePlanSections(text: string): PlanSection[] {
  const sections: PlanSection[] = [];
  let current: PlanSection | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/<[^>]+>/g, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed === "JARVIS · План" || trimmed.startsWith("Нажми номер")) continue;
    const row = trimmed.match(/^(\d+)\s·\s(.+)$/);
    if (row && current) {
      current.rows.push({ number: Number(row[1]), text: row[2].trim(), details: [] });
      continue;
    }
    if (/^\s/.test(line) && current?.rows.length) {
      current.rows[current.rows.length - 1].details.push(trimmed);
      continue;
    }
    if (trimmed.endsWith(":")) {
      current = { title: trimmed.slice(0, -1), rows: [], note: null };
      sections.push(current);
      continue;
    }
    if (current) current.note = trimmed;
  }
  return sections.filter((section) => section.rows.length || section.note);
}

export type NutritionGoals = {
  calories: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  workoutPercent: 0 | 50 | 100;
};

export const DEFAULT_NUTRITION_GOALS: NutritionGoals = {
  calories: 2100,
  proteinG: 150,
  fatG: 70,
  carbsG: 215,
  workoutPercent: 50,
};

// Watches overestimate burn, so only the chosen share of workout calories joins the day.
export function computeCalorieBudget(params: {
  goals: NutritionGoals;
  eaten: FoodMacros;
  workoutCalories: number;
}) {
  const bonus = Math.round((params.workoutCalories * params.goals.workoutPercent) / 100);
  const target = params.goals.calories + bonus;
  return {
    target,
    bonus,
    eaten: params.eaten.calories,
    remaining: target - params.eaten.calories,
    progress: target > 0 ? Math.min(1, params.eaten.calories / target) : 0,
  };
}

// The user edits grams per ingredient; each item scales by its own original density.
export function scaleFoodItems(items: FoodItemEstimate[], grams: Array<number | null>) {
  const scaled = items.flatMap((item, index) => {
    const next = grams[index];
    if (next === null || next === undefined || next === item.grams) return [item];
    if (next <= 0) return [];
    if (!item.grams) return [{ ...item, grams: Math.round(next) }];
    const factor = next / item.grams;
    return [
      {
        ...item,
        grams: Math.round(next),
        calories: Math.round(item.calories * factor),
        proteinG: Math.round(item.proteinG * factor),
        fatG: Math.round(item.fatG * factor),
        carbsG: Math.round(item.carbsG * factor),
      },
    ];
  });
  return { items: scaled, totals: sumFoodMacros(scaled) };
}
