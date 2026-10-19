import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  resolveMiniAppOwner: vi.fn(),
  transcribeMediaWithUsage: vi.fn(),
  askJarvis: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("@/lib/telegramWebApp", () => ({ resolveMiniAppOwner: calls.resolveMiniAppOwner }));
vi.mock("@/ai/transcription", () => ({
  transcribeMediaWithUsage: calls.transcribeMediaWithUsage,
}));
vi.mock("@/services/jarvisAgent", () => ({ askJarvis: calls.askJarvis }));
vi.mock("@/db/queries/audit", () => ({ writeAudit: calls.writeAudit }));
vi.mock("@/db/queries/coach", () => ({ archiveCoachConversation: vi.fn() }));
vi.mock("@/services/coach", () => ({
  listCoachConversation: vi.fn(async () => []),
  uploadRideToCoach: vi.fn(),
}));

import { POST } from "@/app/api/miniapp/coach/route";
import { voiceFileName } from "@/services/voiceQuestion";

const OWNER = { id: "u1", timezone: "Europe/Moscow" };

function voiceRequest(bytes: number, type = "audio/webm;codecs=opus") {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(bytes)], { type }), "voice.webm");
  return new Request("http://localhost/api/miniapp/coach", { method: "POST", body: form });
}

describe("a question spoken in the app", () => {
  beforeEach(() => {
    for (const fn of Object.values(calls)) fn.mockReset();
    calls.resolveMiniAppOwner.mockResolvedValue(OWNER);
    calls.writeAudit.mockResolvedValue(undefined);
    calls.askJarvis.mockResolvedValue({ messages: [{ id: "m" }], changed: true });
  });

  it("is transcribed and goes to JARVIS like a typed one", async () => {
    calls.transcribeMediaWithUsage.mockResolvedValue({
      text: "  напомни завтра в 10   оплатить кружок ",
      model: "gpt-4o-mini-transcribe",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      durationSeconds: 3,
    });
    const response = await POST(voiceRequest(5000));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      messages: [{ id: "m" }],
      changed: true,
      transcript: "напомни завтра в 10 оплатить кружок",
    });
    expect(calls.transcribeMediaWithUsage.mock.calls[0][0]).toMatchObject({
      filename: "voice.webm",
      mimeType: "audio/webm;codecs=opus",
    });
    expect(calls.askJarvis).toHaveBeenCalledWith({
      user: OWNER,
      message: "напомни завтра в 10 оплатить кружок",
    });
    expect(calls.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "miniapp_voice" }),
    );
  });

  it("silence is not sent to JARVIS, and a failed transcription says so", async () => {
    calls.transcribeMediaWithUsage.mockResolvedValue({ text: "  ", model: "m" });
    let response = await POST(voiceRequest(5000));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "voice_empty" });

    calls.transcribeMediaWithUsage.mockRejectedValue(new Error("openai down"));
    response = await POST(voiceRequest(5000));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "voice_failed" });
    expect(calls.askJarvis).not.toHaveBeenCalled();
  });

  it("an empty or huge recording is refused before transcription", async () => {
    expect((await POST(voiceRequest(0))).status).toBe(400);
    expect((await POST(voiceRequest(11 * 1024 * 1024))).status).toBe(400);
    expect(calls.transcribeMediaWithUsage).not.toHaveBeenCalled();
  });

  it("only the owner can ask", async () => {
    calls.resolveMiniAppOwner.mockResolvedValue(null);
    expect((await POST(voiceRequest(5000))).status).toBe(401);
  });

  it.each([
    ["audio/webm;codecs=opus", "voice.webm"],
    ["audio/mp4", "voice.m4a"],
    ["audio/ogg;codecs=opus", "voice.ogg"],
    ["audio/wav", "voice.wav"],
    [null, "voice.webm"],
  ])("a %s recording is sent as %s", (type, name) => {
    expect(voiceFileName(type)).toBe(name);
  });
});
