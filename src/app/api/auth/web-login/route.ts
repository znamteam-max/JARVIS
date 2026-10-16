import { NextResponse } from "next/server";

import { webSessionCookie, WEB_SESSION_TTL_MS } from "@/domain/webSession";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  getWebLoginState,
  logoutWebSession,
  requestWebLogin,
  WebLoginRateLimited,
} from "@/services/webLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_MAX_AGE_S = Math.floor(WEB_SESSION_TTL_MS / 1000);

// Step 1: the device asks; the cookie is set right away and becomes valid once approved.
export async function POST(request: Request) {
  try {
    const { token, code } = await requestWebLogin({
      userAgent: request.headers.get("user-agent"),
    });
    const response = NextResponse.json({
      ok: true,
      code,
      botUsername: getEnv().TELEGRAM_BOT_USERNAME ?? null,
    });
    response.headers.set("set-cookie", webSessionCookie(token, COOKIE_MAX_AGE_S));
    return response;
  } catch (error) {
    if (error instanceof WebLoginRateLimited) {
      return NextResponse.json({ ok: false, error: "too_many_requests" }, { status: 429 });
    }
    logger.warn("Web login request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "login_failed" }, { status: 502 });
  }
}

// Step 2: the device polls until the owner taps "Разрешить" in Telegram.
export async function GET(request: Request) {
  const { state, code } = await getWebLoginState(request);
  return NextResponse.json({ ok: true, state, code });
}

export async function DELETE(request: Request) {
  await logoutWebSession(request);
  const response = NextResponse.json({ ok: true });
  response.headers.set("set-cookie", webSessionCookie("", 0));
  return response;
}
