import { InlineKeyboard } from "grammy";
import { DateTime } from "luxon";

import { getBot } from "@/bot/createBot";
import { getUserById, getUserByTelegramId } from "@/db/queries/users";
import {
  countWebLoginRequestsSince,
  getWebSessionById,
  getWebSessionByTokenHash,
  insertWebLoginRequest,
  touchWebSession,
  transitionWebSession,
} from "@/db/queries/webSessions";
import type { WebSession } from "@/db/schema";
import {
  describeDevice,
  hashWebSessionToken,
  newWebLoginCode,
  newWebSessionToken,
  readCookie,
  WEB_LOGIN_TTL_MS,
  WEB_SESSION_COOKIE,
  WEB_SESSION_TOUCH_MS,
  WEB_SESSION_TTL_MS,
  webSessionState,
} from "@/domain/webSession";
import { getAllowedTelegramUserIds } from "@/lib/env";

// Anyone can open the page, so requests are capped to keep the owner's chat quiet.
const MAX_REQUESTS_PER_WINDOW = 3;

export class WebLoginRateLimited extends Error {}

async function getOwner() {
  const [ownerTelegramId] = [...getAllowedTelegramUserIds()];
  return ownerTelegramId ? getUserByTelegramId(ownerTelegramId) : null;
}

export async function requestWebLogin(params: { userAgent: string | null; now?: Date }) {
  const now = params.now ?? new Date();
  const owner = await getOwner();
  if (!owner) throw new Error("Owner is not configured");
  const recent = await countWebLoginRequestsSince(new Date(now.getTime() - WEB_LOGIN_TTL_MS));
  if (recent >= MAX_REQUESTS_PER_WINDOW) throw new WebLoginRateLimited();

  const token = newWebSessionToken();
  const code = newWebLoginCode();
  const device = describeDevice(params.userAgent);
  const session = await insertWebLoginRequest({
    userId: owner.id,
    tokenHash: hashWebSessionToken(token),
    code,
    device,
    expiresAt: new Date(now.getTime() + WEB_LOGIN_TTL_MS),
  });
  await getBot().api.sendMessage(
    owner.telegramUserId.toString(),
    [
      "🔐 Вход в приложение JARVIS",
      `Устройство: ${device}`,
      `Код на экране: ${code}`,
      "",
      "Если это не вы — нажмите «Отклонить».",
    ].join("\n"),
    {
      reply_markup: new InlineKeyboard()
        .text("✅ Разрешить", `weblogin:approve:${session.id}`)
        .text("🚫 Отклонить", `weblogin:deny:${session.id}`),
    },
  );
  return { token, code };
}

function tokenFrom(request: Request) {
  return readCookie(request.headers.get("cookie"), WEB_SESSION_COOKIE);
}

async function sessionFrom(request: Request) {
  const token = tokenFrom(request);
  return token ? getWebSessionByTokenHash(hashWebSessionToken(token)) : null;
}

export async function getWebLoginState(request: Request, now = new Date()) {
  const session = await sessionFrom(request);
  return { state: webSessionState(session, now), code: session?.code ?? null };
}

// The session slides: every hour of use pushes the 180-day expiry forward.
export async function resolveWebSessionOwner(request: Request, now = new Date()) {
  const session = await sessionFrom(request);
  if (webSessionState(session, now) !== "active" || !session) return null;
  if (!session.lastSeenAt || now.getTime() - session.lastSeenAt.getTime() > WEB_SESSION_TOUCH_MS) {
    await touchWebSession({
      id: session.id,
      at: now,
      expiresAt: new Date(now.getTime() + WEB_SESSION_TTL_MS),
    });
  }
  return getUserById(session.userId);
}

export async function logoutWebSession(request: Request, now = new Date()) {
  const session = await sessionFrom(request);
  if (session) await revokeWebSession(session, now);
}

async function revokeWebSession(session: WebSession, now: Date) {
  for (const from of ["active", "pending"]) {
    const revoked = await transitionWebSession({ id: session.id, from, to: "revoked", at: now });
    if (revoked) return revoked;
  }
  return null;
}

export async function decideWebLogin(params: {
  ownerId: string;
  sessionId: string;
  decision: "approve" | "deny" | "revoke";
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const session = await getWebSessionById(params.sessionId);
  if (!session || session.userId !== params.ownerId) return { outcome: "missing" as const };
  if (params.decision === "revoke") {
    const revoked = await revokeWebSession(session, now);
    return { outcome: revoked ? ("revoked" as const) : ("stale" as const), session };
  }
  if (webSessionState(session, now) !== "pending") return { outcome: "stale" as const, session };
  const updated = await transitionWebSession({
    id: session.id,
    from: "pending",
    to: params.decision === "approve" ? "active" : "denied",
    at: now,
    expiresAt:
      params.decision === "approve" ? new Date(now.getTime() + WEB_SESSION_TTL_MS) : undefined,
  });
  if (!updated) return { outcome: "stale" as const, session };
  return {
    outcome: params.decision === "approve" ? ("approved" as const) : ("denied" as const),
    session: updated,
  };
}

export function formatWebSessionLine(session: WebSession, timezone: string) {
  const at = DateTime.fromJSDate(session.updatedAt, { zone: "utc" }).setZone(timezone);
  return `${session.device ?? "устройство"}, ${at.toFormat("dd.LL HH:mm")}`;
}
