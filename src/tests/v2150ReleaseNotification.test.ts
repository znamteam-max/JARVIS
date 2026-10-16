import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReleaseNotification } from "@/db/schema";
import {
  buildReleaseNotificationText,
  notifyProductionRelease,
  renderReleaseHandoffChecklist,
  renderReleaseNotesMessage,
  renderVersionMessage,
  sanitizeReleaseLines,
  type ReleaseInspection,
  type ReleaseNotificationDependencies,
  type ReleaseNotificationStore,
} from "@/services/releaseNotification";

const version = "2.15.0";
const commitSha = "abcdef1234567890";

describe("V2.15.0 release notification", () => {
  beforeEach(() => {
    process.env.ALLOWED_TELEGRAM_USER_IDS = "42";
  });

  it("sends one release notification after all completion gates pass", async () => {
    const harness = createHarness();
    const result = await notifyProductionRelease(validInput(), harness.dependencies);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        sent: true,
        version,
        commitSha,
        telegramMessageId: "101",
      }),
    );
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.records[0]).toEqual(
      expect.objectContaining({
        status: "sent",
        attemptCount: 1,
        telegramMessageId: 101n,
      }),
    );
  });

  it("does not send twice for the same version and commit", async () => {
    const harness = createHarness();
    await notifyProductionRelease(validInput(), harness.dependencies);
    const duplicate = await notifyProductionRelease(validInput(), harness.dependencies);

    expect(duplicate).toEqual(
      expect.objectContaining({ ok: true, sent: false, reason: "already_sent" }),
    );
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it("allows a same-version hotfix only with an explicit flag", async () => {
    const harness = createHarness();
    await notifyProductionRelease(validInput(), harness.dependencies);
    harness.inspection.commitSha = "bbbbbb1234567890";

    const blocked = await notifyProductionRelease(
      validInput({
        commitSha: "bbbbbb1234567890",
        handoffCurrentProductionCommit: "bbbbbb1234567890",
      }),
      harness.dependencies,
    );
    expect(blocked.reason).toBe("hotfix_requires_explicit_allow");

    const sent = await notifyProductionRelease(
      validInput({
        commitSha: "bbbbbb1234567890",
        handoffCurrentProductionCommit: "bbbbbb1234567890",
        allowHotfix: true,
      }),
      harness.dependencies,
    );
    expect(sent.sent).toBe(true);
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it("blocks release notification when Current Production handoff is stale", async () => {
    const harness = createHarness();
    const result = await notifyProductionRelease(
      validInput({ handoffCurrentProductionCommit: "stale-commit" }),
      harness.dependencies,
    );

    expect(result.reason).toBe("handoff_current_production_mismatch");
    expect(harness.send).not.toHaveBeenCalled();
  });

  it.each([
    [{ healthOk: false }, "health_failed"],
    [{ version: "2.14.0" }, "version_mismatch"],
    [{ commitSha: "different" }, "commit_mismatch"],
    [{ webhookOk: false }, "webhook_unhealthy"],
    [{ runnerOk: false }, "runner_unhealthy"],
  ] as const)("blocks incomplete production state: %s", async (patch, reason) => {
    const harness = createHarness(patch);
    const result = await notifyProductionRelease(validInput(), harness.dependencies);
    expect(result.reason).toBe(reason);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("records Telegram failure and permits a retry", async () => {
    const harness = createHarness();
    harness.send.mockRejectedValueOnce(new Error("network"));

    const failed = await notifyProductionRelease(validInput(), harness.dependencies);
    const retried = await notifyProductionRelease(validInput(), harness.dependencies);

    expect(failed.reason).toBe("telegram_send_failed");
    expect(retried.sent).toBe(true);
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.records[0]).toEqual(
      expect.objectContaining({
        status: "sent",
        attemptCount: 2,
        lastError: null,
      }),
    );
  });

  it("requires migration, smoke and handoff completion evidence", async () => {
    const harness = createHarness();
    expect(
      (await notifyProductionRelease(validInput({ handoffUpdated: false }), harness.dependencies))
        .reason,
    ).toBe("handoff_not_updated");
    expect(
      (await notifyProductionRelease(validInput({ tests: ["smoke:passed"] }), harness.dependencies))
        .reason,
    ).toBe("migrations_not_verified");
    expect(
      (
        await notifyProductionRelease(
          validInput({ tests: ["migrations:applied"] }),
          harness.dependencies,
        )
      ).reason,
    ).toBe("smoke_not_recorded");
  });

  it("renders concise version, release notes and handoff status", () => {
    const latest = releaseRecord({ status: "sent", sentAt: new Date("2026-06-15T13:20:00Z") });
    const versionText = renderVersionMessage({ inspection: healthyInspection(), latest });
    const notes = renderReleaseNotesMessage();
    const checklist = renderReleaseHandoffChecklist({
      notificationStatus: "sent",
      telegramMessageId: "101",
      idempotencyVerified: true,
    });

    expect(versionText).toContain("Версия: V2.15.0");
    expect(versionText).toContain("Коммит: abcdef12");
    expect(versionText).toContain("Webhook: ok");
    expect(notes).toContain("до тех пор, когда не сделаю, каждый час");
    expect(notes).toContain("исходный текст выигрывает у плохого AI-предложения");
    expect(checklist).toContain("Release notification: sent");
    expect(checklist).toContain("Notification idempotency: verified");
  });

  it("redacts secrets from notification content and stored summary lines", () => {
    const unsafe = [
      "OPENAI_API_KEY=sk-project-secret-value-123456789",
      "DATABASE_URL=postgresql://user:pass@example.test/db",
      "Authorization: Bearer secret-token",
      "TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyzABCDE",
    ];
    const sanitized = sanitizeReleaseLines(unsafe);
    const text = buildReleaseNotificationText({
      version,
      commitSha,
      summary: unsafe,
      tests: ["smoke:passed"],
      inspection: healthyInspection(),
    });

    expect(sanitized.join("\n")).not.toContain("secret");
    expect(text).not.toContain("postgresql://");
    expect(text).not.toContain("sk-project");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("[redacted]");
  });
});

describe("V2.15.0 protected endpoint auth", () => {
  it("rejects release notification calls without the admin bearer token", async () => {
    process.env.CRON_SECRET = "test-cron-secret";
    const { resetEnvCacheForTests } = await import("@/lib/env");
    resetEnvCacheForTests();
    const { POST } = await import("@/app/api/admin/repair/route");

    const response = await POST(
      new Request("http://localhost/api/admin/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "release_notify",
          version,
          commitSha,
          handoffUpdated: true,
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  }, 20_000); // cold-imports the whole admin repair route; 5 s is not enough on a busy machine
});

function validInput(
  overrides: Partial<Parameters<typeof notifyProductionRelease>[0]> = {},
): Parameters<typeof notifyProductionRelease>[0] {
  return {
    version,
    commitSha,
    summary: ["release notification"],
    tests: ["migrations:applied", "smoke:passed", "health", "webhook", "runner"],
    handoffUpdated: true,
    handoffCurrentProductionVersion: version,
    handoffCurrentProductionCommit: commitSha,
    ...overrides,
  };
}

function healthyInspection(): ReleaseInspection {
  return {
    healthOk: true,
    version,
    commitSha,
    webhookOk: true,
    runnerOk: true,
    schedulerConfigured: true,
    lastRunnerRunAt: "2026-06-15T13:19:00.000Z",
    warnings: [],
  };
}

function createHarness(inspectionPatch: Partial<ReleaseInspection> = {}) {
  const records: ReleaseNotification[] = [];
  const inspection = { ...healthyInspection(), ...inspectionPatch };
  const send = vi.fn(async () => ({ messageId: 101n }));
  const store: ReleaseNotificationStore = {
    async getLatest() {
      return records.at(-1) ?? null;
    },
    async getLatestSentForVersion(requestedVersion, environment) {
      return (
        [...records]
          .reverse()
          .find(
            (record) =>
              record.version === requestedVersion &&
              record.environment === environment &&
              record.status === "sent",
          ) ?? null
      );
    },
    async reserve(params) {
      const existing = records.find(
        (record) =>
          record.version === params.key.version &&
          record.commitSha === params.key.commitSha &&
          record.environment === params.key.environment,
      );
      if (existing?.status === "sent") {
        return { state: "already_sent" as const, notification: existing };
      }
      if (existing?.status === "pending") {
        return { state: "in_progress" as const, notification: existing };
      }
      if (existing) {
        existing.status = "pending";
        existing.lastError = null;
        existing.attemptCount += 1;
        existing.summary = params.summary;
        existing.updatedAt = new Date();
        return { state: "reserved" as const, notification: existing };
      }
      const created = releaseRecord({
        version: params.key.version,
        commitSha: params.key.commitSha,
        environment: params.key.environment,
        summary: params.summary,
      });
      records.push(created);
      return { state: "reserved" as const, notification: created };
    },
    async markSent(params) {
      const record = records.find((candidate) => candidate.id === params.id)!;
      record.status = "sent";
      record.sentAt = new Date();
      record.telegramMessageId = params.telegramMessageId;
      record.summary = params.summary;
      record.lastError = null;
      return record;
    },
    async markFailed(params) {
      const record = records.find((candidate) => candidate.id === params.id)!;
      record.status = "failed";
      record.lastError = params.error;
      record.summary = params.summary;
      return record;
    },
  };
  const dependencies: ReleaseNotificationDependencies = {
    store,
    inspect: async () => inspection,
    send,
  };
  return { records, inspection, send, dependencies };
}

function releaseRecord(overrides: Partial<ReleaseNotification> = {}): ReleaseNotification {
  const now = new Date("2026-06-15T13:20:00.000Z");
  return {
    id: crypto.randomUUID(),
    version,
    commitSha,
    environment: "production",
    status: "pending",
    sentAt: null,
    telegramMessageId: null,
    summary: {},
    lastError: null,
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
