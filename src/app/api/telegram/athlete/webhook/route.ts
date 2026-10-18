import { after, NextResponse } from "next/server";

import { handleAthleteUpdate, type TelegramUpdate } from "@/athleteBot/handlers";
import { athleteWebhookSecret, isAthleteBotConfigured } from "@/athleteBot/telegram";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The coach answers after Telegram already has its 200 (it would resend a slow update).
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!isAthleteBotConfigured()) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 404 });
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== athleteWebhookSecret()) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  if (update?.message) {
    after(() =>
      handleAthleteUpdate(update).catch((error) =>
        logger.warn("Coach bot update failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }
  return NextResponse.json({ ok: true });
}
