import { NextResponse } from "next/server";

import { buildStravaAuthorizeUrl, readStravaState } from "@/integrations/strava";
import { isStravaConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isStravaConfigured()) {
    return NextResponse.json({ ok: false, error: "strava_not_configured" }, { status: 503 });
  }
  const state = new URL(request.url).searchParams.get("state");
  if (!state || !readStravaState(state)) {
    return NextResponse.json({ ok: false, error: "invalid_or_expired_link" }, { status: 403 });
  }
  return NextResponse.redirect(buildStravaAuthorizeUrl(state));
}
