import { createHash, randomBytes, randomInt } from "node:crypto";

// __Host- cookies are https-only, host-only and path=/ — nobody else can set or read them.
export const WEB_SESSION_COOKIE = "__Host-jarvis_session";
export const WEB_LOGIN_TTL_MS = 10 * 60 * 1000;
export const WEB_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const WEB_SESSION_TOUCH_MS = 60 * 60 * 1000;

export function newWebSessionToken() {
  return randomBytes(32).toString("base64url");
}

// Only the hash is stored, so a database leak does not hand out working sessions.
export function hashWebSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Shown on the device and in the Telegram request, so the owner can match the two.
export function newWebLoginCode() {
  return String(randomInt(1000, 10000));
}

export function readCookie(header: string | null, name: string) {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function webSessionCookie(token: string, maxAgeS: number) {
  return `${WEB_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;
}

export function describeDevice(userAgent: string | null) {
  const ua = userAgent ?? "";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /Linux/.test(ua)
              ? "Linux"
              : "неизвестное устройство";
  const browser = /YaBrowser/.test(ua)
    ? "Яндекс Браузер"
    : /Edg\//.test(ua)
      ? "Edge"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /Firefox|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome|CriOS/.test(ua)
            ? "Chrome"
            : /Safari/.test(ua)
              ? "Safari"
              : null;
  return browser ? `${os} · ${browser}` : os;
}

export type WebSessionState = "none" | "pending" | "active" | "denied" | "expired";

export function webSessionState(
  session: { status: string; expiresAt: Date } | null,
  now: Date,
): WebSessionState {
  if (!session) return "none";
  if (session.status === "denied") return "denied";
  if (session.status === "revoked") return "none";
  if (session.expiresAt.getTime() <= now.getTime()) return "expired";
  return session.status === "active" ? "active" : "pending";
}
