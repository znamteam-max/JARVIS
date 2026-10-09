import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetEnvCacheForTests } from "@/lib/env";
import { POST } from "@/app/api/ops/watchdog/route";

function call(body: unknown, authorization?: string) {
  return POST(
    new Request("http://localhost/api/ops/watchdog", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("V3.0.9 watchdog relay", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.OPS_WATCHDOG_SECRET = "watchdog-test-secret";
    process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
    process.env.ALLOWED_TELEGRAM_USER_IDS = "52203584";
    resetEnvCacheForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    delete process.env.OPS_WATCHDOG_SECRET;
    resetEnvCacheForTests();
    vi.unstubAllGlobals();
  });

  it("rejects calls without the watchdog bearer", async () => {
    const response = await call({ action: "alert", text: "x" }, "Bearer wrong");
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is disabled until the secret is configured", async () => {
    delete process.env.OPS_WATCHDOG_SECRET;
    resetEnvCacheForTests();
    const response = await call({ action: "alert", text: "x" }, "Bearer ");
    expect(response.status).toBe(503);
  });

  it("sends the alert to the owner only", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const response = await call(
      { action: "alert", text: "⚠️ JARVIS: что-то сломалось" },
      "Bearer watchdog-test-secret",
    );
    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.telegram.org/bot123:test-token/sendMessage");
    expect(JSON.parse(String(init.body))).toMatchObject({
      chat_id: "52203584",
      text: "⚠️ JARVIS: что-то сломалось",
    });
  });

  it("summarises webhook delivery without exposing the token", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            url: "https://example.test/api/telegram/webhook",
            pending_update_count: 3,
            last_error_date: 1791529000,
            last_error_message: "Read timeout expired",
          },
        }),
        { status: 200 },
      ),
    );
    const response = await call({ action: "webhook_info" }, "Bearer watchdog-test-secret");
    expect(await response.json()).toEqual({
      ok: true,
      webhookConfigured: true,
      pendingUpdateCount: 3,
      lastErrorDate: 1791529000,
      lastErrorMessage: "Read timeout expired",
    });
  });
});
