import { transcribeMediaWithUsage } from "@/ai/transcription";
import { writeAudit } from "@/db/queries/audit";
import type { User } from "@/db/schema";

// A question spoken in the app: a couple of minutes of speech is well under this.
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Array<[RegExp, string]> = [
  [/webm/i, "webm"],
  [/mp4|m4a|aac/i, "m4a"],
  [/ogg|opus/i, "ogg"],
  [/wav/i, "wav"],
  [/mpeg|mp3/i, "mp3"],
];

// The transcription service tells formats apart by the file name.
export function voiceFileName(mimeType: string | null | undefined) {
  const match = EXTENSIONS.find(([pattern]) => pattern.test(mimeType ?? ""));
  return `voice.${match ? match[1] : "webm"}`;
}

// The same speech-to-text as voice messages to the bot, counted in the same usage log.
export async function transcribeVoiceQuestion(params: {
  user: User;
  bytes: Uint8Array;
  mimeType: string | null;
}) {
  const transcription = await transcribeMediaWithUsage({
    bytes: Buffer.from(params.bytes),
    filename: voiceFileName(params.mimeType),
    mimeType: params.mimeType,
  });
  await writeAudit({
    userId: params.user.id,
    action: "assistant.openai_usage",
    entityType: "miniapp_voice",
    details: {
      capability: "transcription",
      model: transcription.model,
      succeeded: true,
      inputTokens: transcription.inputTokens,
      outputTokens: transcription.outputTokens,
      totalTokens: transcription.totalTokens,
      durationSeconds: transcription.durationSeconds,
    },
  }).catch(() => undefined);
  return transcription.text.replace(/\s+/g, " ").trim();
}
