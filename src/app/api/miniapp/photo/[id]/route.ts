import { NextResponse } from "next/server";

import { getFoodEntryPhoto } from "@/db/queries/food";
import { verifyFoodPhotoSignature } from "@/domain/foodPhoto";
import { getMedia } from "@/integrations/mediaStore";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streams a food photo from Cloudflare R2; the signed link comes from the Mini App summary.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const secret = getEnv().MEDIA_WORKER_TOKEN;
  const valid =
    secret &&
    verifyFoodPhotoSignature({
      entryId: id,
      expires: url.searchParams.get("e"),
      signature: url.searchParams.get("s"),
      secret,
      now: new Date(),
    });
  if (!valid) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const entry = await getFoodEntryPhoto(id);
  if (!entry?.photoKey || entry.status !== "active") {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const media = await getMedia(entry.photoKey);
  if (!media) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return new Response(media.bytes, {
    headers: {
      "content-type": media.contentType,
      "cache-control": "private, max-age=86400",
    },
  });
}
