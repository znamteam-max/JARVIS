import { describe, expect, it } from "vitest";

import {
  anchorDraft,
  caloriesFromMacros,
  draftTotals,
  draftWeight,
  finishFoodDraft,
  newDraftItem,
  setDraftCalories,
  setDraftGrams,
  setDraftMacro,
  setDraftTotalWeight,
  startFoodDraft,
} from "@/domain/foodEdit";

const LAVASH = { name: "лаваш", grams: 100, calories: 280, proteinG: 9, fatG: 1, carbsG: 58 };
const CHICKEN = { name: "курица", grams: 120, calories: 200, proteinG: 30, fatG: 8, carbsG: 0 };

describe("food editor calculator", () => {
  it("К follows Б/Ж/У: 4, 9 and 4 kcal per gram", () => {
    expect(caloriesFromMacros({ proteinG: 10, fatG: 10, carbsG: 10 })).toBe(170);
  });

  it("changing fat changes calories", () => {
    const [item] = startFoodDraft([CHICKEN]);
    const edited = setDraftMacro(item, "fatG", 18);
    expect(edited.fatG).toBe(18);
    expect(edited.calories).toBe(30 * 4 + 18 * 9);
  });

  it("weight scales every number of the product, typed digit by digit", () => {
    const [item] = startFoodDraft([LAVASH]);
    let edited = setDraftGrams(item, 5);
    edited = setDraftGrams(edited, 50);
    expect(edited).toMatchObject({ grams: 50, calories: 140, carbsG: 29, proteinG: 5 });
  });

  it("calories typed by hand scale Б/Ж/У in proportion and keep the typed number", () => {
    const [item] = startFoodDraft([CHICKEN]);
    let edited = setDraftCalories(item, 3);
    edited = setDraftCalories(edited, 300);
    expect(edited.calories).toBe(300);
    expect(edited.proteinG).toBe(Math.round((30 * 300) / caloriesFromMacros(CHICKEN)));
  });

  it("the dish weight resizes all weighed products together", () => {
    const draft = startFoodDraft([LAVASH, CHICKEN, { ...newDraftItem(), name: "соус" }]);
    expect(draftWeight(draft)).toBe(220);
    const half = setDraftTotalWeight(draft, 110);
    expect(half.map((item) => item.grams)).toEqual([50, 60, null]);
    expect(draftTotals(half).calories).toBe(140 + 100);
  });

  it("a product edit survives a later dish-weight change once the field is left", () => {
    let draft = startFoodDraft([LAVASH, CHICKEN]);
    draft = [setDraftGrams(draft[0], 50), draft[1]];
    draft = anchorDraft(draft);
    const doubled = setDraftTotalWeight(draft, 340);
    expect(doubled.map((item) => item.grams)).toEqual([100, 240]);
  });

  it("totals add up the products and empty rows are dropped on save", () => {
    const draft = [...startFoodDraft([LAVASH, CHICKEN]), newDraftItem()];
    expect(draftTotals(draft)).toEqual({ calories: 480, proteinG: 39, fatG: 9, carbsG: 58 });
    const saved = finishFoodDraft(draft);
    expect(saved).toHaveLength(2);
    expect(saved[0]).not.toHaveProperty("base");
  });
});
