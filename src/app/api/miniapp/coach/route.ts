import { NextResponse } from "next/server";
import { z } from "zod";

import { archiveCoachConversation } from "@/db/queries/coach";
import { UserFacingError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import { listCoachConversation, uploadRideToCoach } from "@/services/coach";
import { askJarvis } from "@/services/jarvisAgent";
import { MAX_VOICE_BYTES, transcribeVoiceQuestion } from "@/services/voiceQuestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The coach reads a long context; give the model time to answer.
export const maxDuration = 120;

const MAX_FIT_BYTES = 8 * 1024 * 1024;
const messageSchema = z.object({ message: z.string().trim().min(1).max(2000) });

export async function GET(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, messages: await listCoachConversation(owner.id) });
}

// JSON {message} = a question; multipart {audio} = a spoken question; multipart {file} =
// a FIT export to review.
export async function POST(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      const audio = form?.get("audio");
      if (audio instanceof File) {
        if (audio.size === 0 || audio.size > MAX_VOICE_BYTES) {
          return NextResponse.json({ ok: false, error: "voice_too_large" }, { status: 400 });
        }
        let transcript: string;
        try {
          transcript = await transcribeVoiceQuestion({
            user: owner,
            bytes: new Uint8Array(await audio.arrayBuffer()),
            mimeType: audio.type || null,
          });
        } catch (error) {
          logger.warn("Voice question transcription failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return NextResponse.json({ ok: false, error: "voice_failed" }, { status: 502 });
        }
        if (!transcript) {
          return NextResponse.json({ ok: false, error: "voice_empty" }, { status: 400 });
        }
        const { messages, changed } = await askJarvis({
          user: owner,
          message: transcript.slice(0, 2000),
        });
        return NextResponse.json({ ok: true, messages, changed, transcript });
      }
      const file = form?.get("file");
      if (!(file instanceof File) || file.size === 0 || file.size > MAX_FIT_BYTES) {
        return NextResponse.json(
          { ok: false, error: "file_missing_or_too_large" },
          { status: 400 },
        );
      }
      const messages = await uploadRideToCoach({
        user: owner,
        bytes: new Uint8Array(await file.arrayBuffer()),
        fileName: file.name || null,
      });
      return NextResponse.json({ ok: true, messages });
    }
    const body = messageSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
    const { messages, changed } = await askJarvis({ user: owner, message: body.data.message });
    return NextResponse.json({ ok: true, messages, changed });
  } catch (error) {
    if (error instanceof UserFacingError) {
      return NextResponse.json(
        { ok: false, error: "user", message: error.message },
        { status: 400 },
      );
    }
    logger.warn("Coach request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { ok: false, error: "coach_failed", messages: await listCoachConversation(owner.id) },
      { status: 502 },
    );
  }
}

// "Новый разговор": the old thread is kept in the database but leaves the coach's memory.
export async function DELETE(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  await archiveCoachConversation(owner.id);
  return NextResponse.json({ ok: true, messages: [] });
}
