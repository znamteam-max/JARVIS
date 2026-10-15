import { createHmac } from "node:crypto";

import { constantTimeEquals } from "@/lib/secrets";

const DAY_MS = 24 * 60 * 60 * 1000;

export function foodPhotoKey(entryId: string) {
  return `food/${entryId}.webp`;
}

// <img> cannot send the Telegram initData header, so photo links carry their own signature.
// A link stays the same for a whole UTC day, which lets the webview cache the picture.
export function signFoodPhotoUrl(params: { entryId: string; secret: string; now: Date }) {
  const expires = Math.floor(params.now.getTime() / DAY_MS) * DAY_MS + 2 * DAY_MS;
  const signature = foodPhotoSignature(params.entryId, expires, params.secret);
  return `/api/miniapp/photo/${params.entryId}?e=${expires}&s=${signature}`;
}

export function verifyFoodPhotoSignature(params: {
  entryId: string;
  expires: string | null;
  signature: string | null;
  secret: string;
  now: Date;
}) {
  const expires = Number(params.expires);
  const now = params.now.getTime();
  if (!Number.isInteger(expires) || expires <= now || expires > now + 3 * DAY_MS) return false;
  return constantTimeEquals(
    params.signature,
    foodPhotoSignature(params.entryId, expires, params.secret),
  );
}

function foodPhotoSignature(entryId: string, expires: number, secret: string) {
  return createHmac("sha256", secret)
    .update(`food-photo:${entryId}:${expires}`)
    .digest("base64url")
    .slice(0, 32);
}
