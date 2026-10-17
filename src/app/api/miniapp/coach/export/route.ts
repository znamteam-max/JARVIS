import { InputFile } from "grammy";
import { NextResponse } from "next/server";

import { getBot } from "@/bot/createBot";
import { logger } from "@/lib/logger";
import { resolveMiniAppOwner } from "@/lib/telegramWebApp";
import { buildCoachChatExport } from "@/services/coachExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: the chat history as a .md download (the standalone app in a browser).
export async function GET(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { fileName, text } = await buildCoachChatExport(owner);
  return new Response(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
    },
  });
}

// POST: inside Telegram a web view cannot save files, so the bot sends the same file.
export async function POST(request: Request) {
  const owner = await resolveMiniAppOwner(request);
  if (!owner) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const { fileName, text } = await buildCoachChatExport(owner);
    await getBot().api.sendDocument(
      owner.telegramUserId.toString(),
      new InputFile(Buffer.from(text, "utf8"), fileName),
      { caption: "История чата JARVIS: время, кто отвечал (модель) и что было сделано." },
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.warn("Chat export to Telegram failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "send_failed" }, { status: 502 });
  }
}
