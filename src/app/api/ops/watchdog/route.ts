import { NextResponse } from "next/server";

import { getAllowedTelegramUserIds, getEnv } from "@/lib/env";
import { constantTimeEquals } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ALERT_LENGTH = 1500;

// Relay for the external watchdog (ops/watchdog). The watchdog server cannot reach
// api.telegram.org directly, so it asks the bot to send the alert. Deliberately no
// database access: the relay must keep working when the DB or the scheduler is down.
export async function POST(request: Request) {
  const env = getEnv();
  const secret = env.OPS_WATCHDOG_SECRET;
  if (!secret || !env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }
  if (!constantTimeEquals(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    text?: unknown;
  } | null;
  const telegram = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

  if (body?.action === "webhook_info") {
    const response = await fetch(`${telegram}/getWebhookInfo`, { cache: "no-store" });
    const info = ((await response.json().catch(() => null)) as { result?: Record<string, unknown> })
      ?.result;
    if (!response.ok || !info) {
      return NextResponse.json({ ok: false, error: "telegram_unavailable" }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      webhookConfigured: Boolean(info.url),
      pendingUpdateCount: Number(info.pending_update_count ?? 0),
      lastErrorDate: typeof info.last_error_date === "number" ? info.last_error_date : null,
      lastErrorMessage:
        typeof info.last_error_message === "string" ? info.last_error_message : null,
    });
  }

  if (body?.action === "alert" && typeof body.text === "string" && body.text.trim()) {
    const [ownerChatId] = [...getAllowedTelegramUserIds()];
    if (!ownerChatId) {
      return NextResponse.json({ ok: false, error: "owner_unknown" }, { status: 503 });
    }
    const response = await fetch(`${telegram}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: ownerChatId,
        text: body.text.trim().slice(0, MAX_ALERT_LENGTH),
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      return NextResponse.json({ ok: false, error: "telegram_send_failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
}
