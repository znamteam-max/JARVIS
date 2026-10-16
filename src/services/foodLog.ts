import { DateTime } from "luxon";

import { estimateFoodFromText } from "@/ai/foodEstimation";
import { writeAudit } from "@/db/queries/audit";
import { insertFoodEntry } from "@/db/queries/food";
import type { User } from "@/db/schema";

const MAX_BACKDATE_DAYS = 7;

export class FoodLogError extends Error {
  constructor(readonly code: "invalid_time" | "not_food_text") {
    super(code);
  }
}

// "Записать без фото" and JARVIS's log_food: words → estimate → entry.
export async function logFoodFromText(params: {
  user: User;
  text: string;
  eatenAtLocal?: string | null;
  capability: string;
}) {
  const now = DateTime.utc();
  const eatenAt = params.eatenAtLocal
    ? DateTime.fromISO(params.eatenAtLocal, { zone: params.user.timezone }).toUTC()
    : now;
  if (
    !eatenAt.isValid ||
    eatenAt > now.plus({ minutes: 5 }) ||
    eatenAt < now.minus({ days: MAX_BACKDATE_DAYS })
  ) {
    throw new FoodLogError("invalid_time");
  }
  const result = await estimateFoodFromText({ text: params.text });
  await writeAudit({
    userId: params.user.id,
    action: "assistant.openai_usage",
    entityType: "food_entry",
    details: {
      capability: params.capability,
      model: result.model,
      succeeded: true,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
    },
  }).catch(() => undefined);
  if (!result.estimate.isFood) throw new FoodLogError("not_food_text");
  const entry = await insertFoodEntry({
    userId: params.user.id,
    sourceMessageId: null,
    telegramFileId: null,
    caption: params.text,
    eatenAt: eatenAt.toJSDate(),
    estimate: result.estimate,
    model: result.model,
  });
  return { entry, estimate: result.estimate };
}
