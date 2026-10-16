import { describe, expect, it } from "vitest";

import {
  describeDevice,
  hashWebSessionToken,
  newWebLoginCode,
  newWebSessionToken,
  readCookie,
  WEB_SESSION_COOKIE,
  webSessionCookie,
  webSessionState,
} from "@/domain/webSession";

const NOW = new Date("2026-10-16T10:00:00Z");
const LATER = new Date("2026-10-16T10:05:00Z");

describe("web login session", () => {
  it("issues long random tokens and stores only their hash", () => {
    const token = newWebSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newWebSessionToken()).not.toBe(token);
    expect(hashWebSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWebSessionToken(token)).not.toContain(token);
  });

  it("shows a four-digit code", () => {
    for (let i = 0; i < 50; i += 1) expect(newWebLoginCode()).toMatch(/^\d{4}$/);
  });

  it("sets a host-only, https-only, script-proof cookie and reads it back", () => {
    const cookie = webSessionCookie("abc", 3600);
    expect(cookie).toContain(`${WEB_SESSION_COOKIE}=abc`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(readCookie(`theme=dark; ${WEB_SESSION_COOKIE}=abc; other=1`, WEB_SESSION_COOKIE)).toBe(
      "abc",
    );
    expect(readCookie(null, WEB_SESSION_COOKIE)).toBeNull();
    expect(readCookie("jarvis_session=abc", WEB_SESSION_COOKIE)).toBeNull();
  });

  it("only an approved, unexpired session opens the app", () => {
    expect(webSessionState(null, NOW)).toBe("none");
    expect(webSessionState({ status: "pending", expiresAt: LATER }, NOW)).toBe("pending");
    expect(webSessionState({ status: "active", expiresAt: LATER }, NOW)).toBe("active");
    expect(webSessionState({ status: "active", expiresAt: NOW }, NOW)).toBe("expired");
    expect(webSessionState({ status: "pending", expiresAt: NOW }, LATER)).toBe("expired");
    expect(webSessionState({ status: "denied", expiresAt: LATER }, NOW)).toBe("denied");
    expect(webSessionState({ status: "revoked", expiresAt: LATER }, NOW)).toBe("none");
  });

  it("names the device in the Telegram request", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone · Safari");
    expect(
      describeDevice(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
      ),
    ).toBe("Android · Chrome");
    expect(
      describeDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 YaBrowser/24.10 Safari/537.36",
      ),
    ).toBe("Windows · Яндекс Браузер");
    expect(describeDevice(null)).toBe("неизвестное устройство");
  });
});
