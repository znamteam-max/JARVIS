import { createHmac, timingSafeEqual } from "node:crypto";

import { getUserByTelegramId } from "@/db/queries/users";
import { getAllowedTelegramUserIds, requireEnv } from "@/lib/env";

const MAX_INIT_DATA_AGE_S = 24 * 60 * 60;

// Telegram signs the Mini App launch data with the bot token; checking it here means
// only the owner, opening the app from Telegram, can read or change anything.
export function verifyTelegramInitData(params: {
  initData: string;
  botToken: string;
  nowS?: number;
  maxAgeS?: number;
}): { telegramUserId: string } | null {
  const data = new URLSearchParams(params.initData);
  const hash = data.get("hash");
  if (!hash) return null;
  data.delete("hash");
  const checkString = [...data.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(params.botToken).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  const actual = Buffer.from(hash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  const authDate = Number(data.get("auth_date"));
  const nowS = params.nowS ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || nowS - authDate > (params.maxAgeS ?? MAX_INIT_DATA_AGE_S)) {
    return null;
  }
  try {
    const user = JSON.parse(data.get("user") ?? "null") as { id?: number } | null;
    return user?.id ? { telegramUserId: String(user.id) } : null;
  } catch {
    return null;
  }
}

export async function resolveMiniAppOwner(request: Request) {
  const initData = request.headers.get("x-telegram-init-data") ?? "";
  const verified = verifyTelegramInitData({ initData, botToken: requireEnv("TELEGRAM_BOT_TOKEN") });
  if (!verified || !getAllowedTelegramUserIds().has(verified.telegramUserId)) return null;
  return getUserByTelegramId(verified.telegramUserId);
}
