import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { foodPhotoKey, signFoodPhotoUrl, verifyFoodPhotoSignature } from "@/domain/foodPhoto";
import { compressFoodPhoto } from "@/services/foodPhotos";

const ENTRY = "5b0d8c52-3f0e-4c3a-9a51-2b7f4f1d9e10";
const SECRET = "test-media-secret";

function parse(url: string) {
  const parsed = new URL(url, "https://example.test");
  return { expires: parsed.searchParams.get("e"), signature: parsed.searchParams.get("s") };
}

describe("food photo links", () => {
  it("stores one WebP per entry", () => {
    expect(foodPhotoKey(ENTRY)).toBe(`food/${ENTRY}.webp`);
  });

  it("keeps the same link for a whole day and accepts it", () => {
    const morning = signFoodPhotoUrl({
      entryId: ENTRY,
      secret: SECRET,
      now: new Date("2026-10-15T06:00:00Z"),
    });
    const evening = signFoodPhotoUrl({
      entryId: ENTRY,
      secret: SECRET,
      now: new Date("2026-10-15T21:00:00Z"),
    });
    expect(morning).toBe(evening);
    expect(morning.startsWith(`/api/miniapp/photo/${ENTRY}?`)).toBe(true);
    expect(
      verifyFoodPhotoSignature({
        entryId: ENTRY,
        ...parse(morning),
        secret: SECRET,
        now: new Date("2026-10-16T12:00:00Z"),
      }),
    ).toBe(true);
  });

  it("rejects expired, foreign and tampered links", () => {
    const now = new Date("2026-10-15T06:00:00Z");
    const link = parse(signFoodPhotoUrl({ entryId: ENTRY, secret: SECRET, now }));
    const check = (overrides: Partial<Parameters<typeof verifyFoodPhotoSignature>[0]>) =>
      verifyFoodPhotoSignature({ entryId: ENTRY, ...link, secret: SECRET, now, ...overrides });
    expect(check({ now: new Date("2026-10-17T00:00:01Z") })).toBe(false);
    expect(check({ entryId: "00000000-0000-0000-0000-000000000000" })).toBe(false);
    expect(check({ secret: "other" })).toBe(false);
    expect(check({ signature: null })).toBe(false);
    expect(check({ expires: String(Number(link.expires) + 86_400_000 * 30) })).toBe(false);
  });
});

describe("light photo copy", () => {
  it("shrinks a big phone photo to a 1080px WebP", async () => {
    const original = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 200, g: 120, b: 40 } },
    })
      .jpeg({ quality: 95 })
      .toBuffer();
    const light = await compressFoodPhoto(original);
    const meta = await sharp(light).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(810);
    expect(light.byteLength).toBeLessThan(150_000);
  });

  it("never enlarges a small photo", async () => {
    const small = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    const meta = await sharp(await compressFoodPhoto(small)).metadata();
    expect([meta.width, meta.height]).toEqual([640, 480]);
  });
});
