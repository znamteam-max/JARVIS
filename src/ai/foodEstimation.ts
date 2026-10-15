import { getOpenAIClient } from "@/ai/openaiClient";
import { normalizeFoodEstimate, type FoodEstimate } from "@/domain/foodEstimate";
import { getEnv } from "@/lib/env";

const FOOD_INSTRUCTIONS = [
  "Ты нутрициолог. По фото блюда оцени, что на тарелке, вес порций и КБЖУ.",
  "Подпись пользователя важнее фото: если там указан состав или вес — используй их.",
  "Не изображай точность: калории округляй до 10, граммы до 5.",
  "Учитывай типичные скрытые калории (масло, соусы), а в note коротко скажи, что могло не попасть в оценку.",
  "Если на фото не еда и подпись тоже не про еду — isFood=false.",
  "Названия пиши по-русски, коротко. Ответь только вызовом report_food_estimate.",
].join("\n");

const numberField = { type: "number" } as const;

const foodEstimateTool = {
  type: "function",
  name: "report_food_estimate",
  description: "Оценка блюда по фото: состав, граммы, калории, белки, жиры, углеводы.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["isFood", "title", "items", "confidence", "note"],
    properties: {
      isFood: { type: "boolean" },
      title: { type: "string", description: "Короткое название блюда" },
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "grams", "calories", "proteinG", "fatG", "carbsG"],
          properties: {
            name: { type: "string" },
            grams: { type: ["number", "null"] },
            calories: numberField,
            proteinG: numberField,
            fatG: numberField,
            carbsG: numberField,
          },
        },
      },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      note: { type: ["string", "null"] },
    },
  },
} as const;

export type FoodEstimationResult = {
  estimate: FoodEstimate;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export async function estimateFoodFromImage(params: {
  bytes: Buffer;
  mimeType: string;
  caption: string | null;
}): Promise<FoodEstimationResult> {
  const model = getEnv().OPENAI_TEXT_MODEL;
  const response = await getOpenAIClient().responses.create({
    model,
    instructions: FOOD_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: params.caption ? `Подпись пользователя: ${params.caption}` : "Подписи нет.",
          },
          {
            type: "input_image",
            image_url: `data:${params.mimeType};base64,${params.bytes.toString("base64")}`,
            detail: "auto",
          },
        ],
      },
    ],
    tools: [foodEstimateTool] as never,
    tool_choice: { type: "function", name: "report_food_estimate" } as never,
    parallel_tool_calls: false,
    max_output_tokens: 1200,
  });
  const call = response.output.find(
    (item) => item.type === "function_call" && item.name === "report_food_estimate",
  ) as { arguments?: string } | undefined;
  if (!call || typeof call.arguments !== "string") {
    throw new SyntaxError("Missing food estimate tool call");
  }
  const usage = response.usage;
  return {
    estimate: normalizeFoodEstimate(JSON.parse(call.arguments)),
    model: response.model ?? model,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}
