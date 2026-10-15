import sharp from "sharp";

import { getBot } from "@/bot/createBot";
import {
  getFoodEntryPhoto,
  listFoodEntriesMissingPhoto,
  setFoodEntryPhoto,
} from "@/db/queries/food";
import { foodPhotoKey } from "@/domain/foodPhoto";
import { deleteMedia, putMedia } from "@/integrations/mediaStore";
import { downloadTelegramMedia } from "@/integrations/telegramFiles";
import { isMediaStoreConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";

const MAX_SIDE = 1080;
const WEBP_QUALITY = 70;
const BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// The "light" copy: 1080px WebP, roughly 50–150 KB. rotate() applies the EXIF
// orientation; all other metadata (GPS included) is dropped.
export async function compressFoodPhoto(bytes: Buffer) {
  return sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

// Best effort: the calorie entry matters more than its picture, so this never throws.
export async function saveFoodPhoto(params: { entryId: string; bytes: Buffer }) {
  if (!isMediaStoreConfigured()) return null;
  const key = foodPhotoKey(params.entryId);
  try {
    await putMedia(key, await compressFoodPhoto(params.bytes), "image/webp");
    await setFoodEntryPhoto({ entryId: params.entryId, photoKey: key, photoStatus: "stored" });
    return key;
  } catch (error) {
    logger.warn("Food photo upload failed", {
      entryId: params.entryId,
      error: error instanceof Error ? error.message : String(error),
    });
    await setFoodEntryPhoto({
      entryId: params.entryId,
      photoKey: null,
      photoStatus: "failed",
    }).catch(() => undefined);
    return null;
  }
}

// "deleted" is final: the backfill below never brings a removed photo back.
export async function deleteFoodPhoto(params: { userId: string; entryId: string }) {
  const entry = await getFoodEntryPhoto(params.entryId);
  if (!entry || entry.userId !== params.userId || !entry.photoKey) return false;
  await deleteMedia(entry.photoKey);
  await setFoodEntryPhoto({ entryId: entry.id, photoKey: null, photoStatus: "deleted" });
  return true;
}

// Bot photos are re-downloadable from Telegram, so older entries get their copy too.
export async function backfillFoodPhotos(now = new Date(), limit = 3) {
  if (!isMediaStoreConfigured()) return { stored: 0, checked: 0 };
  const entries = await listFoodEntriesMissingPhoto({
    since: new Date(now.getTime() - BACKFILL_WINDOW_MS),
    limit,
  });
  let stored = 0;
  for (const entry of entries) {
    if (!entry.telegramFileId) continue;
    try {
      const bytes = await downloadTelegramMedia(getBot(), {
        fileId: entry.telegramFileId,
        mimeType: "image/jpeg",
        filename: "food.jpg",
      });
      if (await saveFoodPhoto({ entryId: entry.id, bytes })) stored += 1;
    } catch (error) {
      logger.warn("Food photo backfill failed", {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await setFoodEntryPhoto({ entryId: entry.id, photoKey: null, photoStatus: "failed" });
    }
  }
  return { stored, checked: entries.length };
}
