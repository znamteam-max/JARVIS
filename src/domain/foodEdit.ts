import type { FoodItemEstimate, FoodMacros } from "@/domain/foodEstimate";

// The calculator behind the Mini App food editor. Pure, so the browser and the tests
// share it: every change keeps К = 4·Б + 9·Ж + 4·У in step.

export type FoodMacroField = "proteinG" | "fatG" | "carbsG";

// Each draft row remembers the values it was last anchored at, so typing 1 → 12 → 120 g
// scales from the same base instead of compounding rounding to zero.
export type FoodDraftItem = FoodItemEstimate & { base: FoodItemEstimate };

const ATWATER: Record<FoodMacroField, number> = { proteinG: 4, fatG: 9, carbsG: 4 };

export function caloriesFromMacros(macros: Pick<FoodMacros, FoodMacroField>) {
  return Math.round(
    macros.proteinG * ATWATER.proteinG +
      macros.fatG * ATWATER.fatG +
      macros.carbsG * ATWATER.carbsG,
  );
}

function anchored(item: FoodItemEstimate): FoodDraftItem {
  const plain: FoodItemEstimate = {
    name: item.name,
    grams: item.grams,
    calories: item.calories,
    proteinG: item.proteinG,
    fatG: item.fatG,
    carbsG: item.carbsG,
  };
  return { ...plain, base: { ...plain } };
}

export function startFoodDraft(items: FoodItemEstimate[]) {
  return items.map(anchored);
}

export function newDraftItem(): FoodDraftItem {
  return anchored({ name: "", grams: null, calories: 0, proteinG: 0, fatG: 0, carbsG: 0 });
}

function scaled(base: FoodItemEstimate, factor: number, grams: number | null): FoodItemEstimate {
  return {
    name: base.name,
    grams,
    calories: Math.round(base.calories * factor),
    proteinG: Math.round(base.proteinG * factor),
    fatG: Math.round(base.fatG * factor),
    carbsG: Math.round(base.carbsG * factor),
  };
}

// Weight changes keep the product's density: 200 g of the same rice is twice the КБЖУ.
export function setDraftGrams(item: FoodDraftItem, grams: number | null): FoodDraftItem {
  if (grams === null) return { ...item, grams: null };
  const next = Math.max(0, Math.round(grams));
  if (!item.base.grams) return anchored({ ...item, grams: next });
  return { ...scaled(item.base, next / item.base.grams, next), name: item.name, base: item.base };
}

// A macro typed by hand is the new truth: calories follow it, and the row re-anchors.
export function setDraftMacro(item: FoodDraftItem, field: FoodMacroField, value: number) {
  const next = { ...item, [field]: Math.max(0, Math.round(value)) };
  return anchored({ ...next, calories: caloriesFromMacros(next) });
}

// Calories typed by hand scale Б/Ж/У in proportion (from the anchor, so typing digit by
// digit is safe); К keeps exactly the typed number.
export function setDraftCalories(item: FoodDraftItem, calories: number): FoodDraftItem {
  const target = Math.max(0, Math.round(calories));
  const baseCalories = caloriesFromMacros(item.base);
  if (baseCalories <= 0) return { ...item, calories: target };
  const factor = target / baseCalories;
  return {
    ...item,
    calories: target,
    proteinG: Math.round(item.base.proteinG * factor),
    fatG: Math.round(item.base.fatG * factor),
    carbsG: Math.round(item.base.carbsG * factor),
  };
}

// Called when a field loses focus: the values on screen become the new anchor.
export function anchorDraft(items: FoodDraftItem[]) {
  return items.map(anchored);
}

export function setDraftName(item: FoodDraftItem, name: string): FoodDraftItem {
  return { ...item, name, base: { ...item.base, name } };
}

export function draftWeight(items: FoodItemEstimate[]) {
  return items.reduce((sum, item) => sum + (item.grams ?? 0), 0);
}

// "Вес блюда": every weighed product grows or shrinks by the same factor.
export function setDraftTotalWeight(items: FoodDraftItem[], total: number) {
  const baseWeight = items.reduce((sum, item) => sum + (item.base.grams ?? 0), 0);
  if (baseWeight <= 0) return items;
  const factor = Math.max(0, total) / baseWeight;
  return items.map((item) =>
    item.base.grams
      ? {
          ...scaled(item.base, factor, Math.round(item.base.grams * factor)),
          name: item.name,
          base: item.base,
        }
      : item,
  );
}

export function draftTotals(items: FoodItemEstimate[]): FoodMacros {
  return items.reduce(
    (sum, item) => ({
      calories: sum.calories + item.calories,
      proteinG: sum.proteinG + item.proteinG,
      fatG: sum.fatG + item.fatG,
      carbsG: sum.carbsG + item.carbsG,
    }),
    { calories: 0, proteinG: 0, fatG: 0, carbsG: 0 },
  );
}

export function finishFoodDraft(items: FoodDraftItem[]): FoodItemEstimate[] {
  return items
    .filter((item) => item.name.trim())
    .map((item) => ({
      name: item.name.trim(),
      grams: item.grams,
      calories: item.calories,
      proteinG: item.proteinG,
      fatG: item.fatG,
      carbsG: item.carbsG,
    }));
}
