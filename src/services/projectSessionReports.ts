import { createHash } from "node:crypto";

import { z } from "zod";

import { askClaudeRelay, isClaudeRelayConfigured } from "@/ai/claudeRelay";
import { canUseOpenAI, getOpenAIClient } from "@/ai/openaiClient";
import { writeAudit } from "@/db/queries/audit";
import {
  claimDueSessionReports,
  failSessionReport,
  finishSessionReport,
  upsertSessionReport,
} from "@/db/queries/projectSessionReports";
import {
  createProject,
  findProjectForReport,
  getProject,
  replaceOpenEntries,
  upsertProjectEntry,
} from "@/db/queries/projects";
import { getUserByTelegramId } from "@/db/queries/users";
import type { Project, ProjectSessionReport } from "@/db/schema";
import { getAllowedTelegramUserIds, getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const SOURCE = "claude_code";
// Turns come in bursts; wait until the session has been quiet this long…
const QUIET_MS = 90 * 1000;
// …but a long busy session still gets its log updated this often.
const MAX_WAIT_MS = 15 * 60 * 1000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// Each report is one model call; the tick runs every minute.
const REPORTS_PER_TICK = 2;
const CLAUDE_TIMEOUT_MS = 45_000;
const MAX_USER_CHARS = 2000;
const MAX_ASSISTANT_HEAD = 5000;
const MAX_ASSISTANT_TAIL = 3000;
const MAX_DONE_CHARS = 600;
const MAX_NEXT = 5;
const MAX_NEXT_CHARS = 200;

export const SESSION_REPORT_INSTRUCTIONS = `Ты ведёшь журнал проектов владельца. Тебе дают последний обмен репликами из сессии Claude Code — что попросил владелец и что ответил Claude, — и то, что про эту сессию уже записано.

Верни JSON:
- done: что сделано в этой сессии на сейчас — 1–3 коротких предложения по-русски, человеческими словами, без путей к файлам, кода и технических подробностей. Запись накопительная: сохрани прежнее и добавь новое. Если в последнем обмене ничего не сделано (вопрос, обсуждение, план), верни прежнее значение без изменений; если записей ещё нет — пустую строку.
- next: до 5 конкретных шагов, которые остались открытыми: что Claude или владелец назвали следующим шагом, что не доделано или не проверено, что ждёт решения владельца. Шаги, которые уже сделаны, убери. Если ничего не осталось — пустой список.

Только факты из текста, ничего не придумывай. Секреты, токены и пароли не переписывай.`;

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["done", "next"],
  properties: {
    done: { type: "string" },
    next: { type: "array", maxItems: MAX_NEXT, items: { type: "string" } },
  },
} as const;

const reportAnswer = z.object({
  done: z.string(),
  next: z.array(z.string()),
});

export type SessionReportInput = {
  sessionId: string;
  repo: string | null;
  folder: string;
  branch: string | null;
  userMessage: string | null;
  assistantMessage: string;
};

// Never store or forward what looks like a secret, whatever the session talked about.
export function redactSecrets(text: string) {
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\s*[=:]\s*\S+/g,
      "$1=[redacted]",
    );
}

function clipAssistant(text: string) {
  return text.length > MAX_ASSISTANT_HEAD + MAX_ASSISTANT_TAIL
    ? `${text.slice(0, MAX_ASSISTANT_HEAD)}\n…\n${text.slice(-MAX_ASSISTANT_TAIL)}`
    : text;
}

// The planner's owner: reports and imports from this computer are always theirs.
export async function resolveReportOwner() {
  const [ownerTelegramId] = [...getAllowedTelegramUserIds()];
  return ownerTelegramId ? getUserByTelegramId(ownerTelegramId) : null;
}

// The hook's POST: find (or start) the project and keep the session's latest report.
// Processing happens on the scheduler tick, so the hook never waits for a model.
export async function receiveSessionReport(input: SessionReportInput, now = new Date()) {
  const owner = await resolveReportOwner();
  if (!owner) return null;
  let project = await findProjectForReport(owner.id, input.repo, input.folder);
  const created = !project;
  if (!project) {
    try {
      project = await createProject({
        userId: owner.id,
        title: input.folder,
        status: "active",
        repo: input.repo,
      });
    } catch (error) {
      // Two sessions in a new repo at once: the other one has just created it.
      project = await findProjectForReport(owner.id, input.repo, input.folder);
      if (!project) throw error;
    }
  }
  const payload = {
    branch: input.branch,
    userMessage: input.userMessage
      ? redactSecrets(input.userMessage).slice(0, MAX_USER_CHARS)
      : null,
    assistantMessage: clipAssistant(redactSecrets(input.assistantMessage)),
  };
  const payloadHash = createHash("sha256")
    .update(`${payload.userMessage ?? ""}\u0000${payload.assistantMessage}`)
    .digest("hex");
  await upsertSessionReport({
    userId: owner.id,
    projectId: project.id,
    sessionId: input.sessionId,
    payload,
    payloadHash,
    receivedAt: now,
  });
  return { projectId: project.id, projectTitle: project.title, created };
}

export function buildSessionReportPrompt(project: Project, report: ProjectSessionReport) {
  const payload = report.payload ?? {};
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return [
    `Проект: ${project.title}`,
    text(payload.branch) ? `Ветка: ${text(payload.branch)}` : null,
    `Уже записано про эту сессию:\nСделано: ${report.done || "пока ничего"}\nВпереди:\n${
      report.next.map((step) => `- ${step}`).join("\n") || "- пусто"
    }`,
    text(payload.userMessage) ? `Последний запрос владельца:\n${text(payload.userMessage)}` : null,
    `Ответ Claude:\n${text(payload.assistantMessage)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseSessionReport(raw: unknown) {
  const parsed = reportAnswer.safeParse(raw);
  if (!parsed.success) throw new Error("report_unparsed");
  const done = parsed.data.done.replace(/\s+/g, " ").trim().slice(0, MAX_DONE_CHARS);
  // The same step twice (in any case) would be one line anyway: its key ignores case.
  const seen = new Set<string>();
  const next = parsed.data.next
    .map((step) => step.replace(/\s+/g, " ").trim().slice(0, MAX_NEXT_CHARS))
    .filter((step) => {
      const key = step.toLowerCase();
      if (!step || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_NEXT);
  return { done, next };
}

// Claude on the owner's subscription first, OpenAI when the relay is down.
async function extractReport(userId: string, prompt: string) {
  if (isClaudeRelayConfigured()) {
    try {
      const answer = await askClaudeRelay({
        system: SESSION_REPORT_INSTRUCTIONS,
        prompt,
        schema: REPORT_SCHEMA as unknown as Record<string, unknown>,
        model: getEnv().CLAUDE_REPORT_MODEL,
        effort: "low",
        timeoutMs: CLAUDE_TIMEOUT_MS,
      });
      if (answer.structured) return parseSessionReport(answer.structured);
    } catch (error) {
      logger.warn("Session report via Claude failed, using OpenAI", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!canUseOpenAI()) throw new Error("no_model");
  const model = getEnv().OPENAI_TEXT_MODEL;
  const response = await getOpenAIClient().responses.create({
    model,
    instructions: SESSION_REPORT_INSTRUCTIONS,
    input: prompt,
    max_output_tokens: 600,
    text: {
      format: {
        type: "json_schema",
        name: "session_report",
        strict: true,
        schema: REPORT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });
  const usage = response.usage;
  await writeAudit({
    userId,
    action: "assistant.openai_usage",
    entityType: "project",
    details: {
      capability: "project_session_report",
      model: response.model ?? model,
      succeeded: true,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
    },
  }).catch(() => undefined);
  return parseSessionReport(JSON.parse(response.output_text || "null"));
}

// One session = one "done so far" line that grows, plus its open next steps.
async function applyReport(params: {
  report: ProjectSessionReport;
  done: string;
  next: string[];
  at: Date;
}) {
  const { report, at } = params;
  const branch = typeof report.payload?.branch === "string" ? report.payload.branch : null;
  if (params.done) {
    await upsertProjectEntry({
      userId: report.userId,
      projectId: report.projectId,
      kind: "done",
      source: SOURCE,
      externalId: `session:${report.sessionId}`,
      text: params.done,
      occurredAt: at,
      metadata: { sessionId: report.sessionId, branch },
    });
  }
  const prefix = `session:${report.sessionId}:next:`;
  await replaceOpenEntries({
    userId: report.userId,
    projectId: report.projectId,
    source: SOURCE,
    prefix,
    items: params.next.map((text) => ({
      externalId: `${prefix}${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 16)}`,
      text,
    })),
    occurredAt: at,
  });
}

export async function processSessionReport(report: ProjectSessionReport, now = new Date()) {
  const project = await getProject(report.userId, report.projectId);
  if (!project) return;
  const processedHash = report.payloadHash;
  try {
    const { done, next } = await extractReport(
      report.userId,
      buildSessionReportPrompt(project, report),
    );
    // An empty "done" from the model keeps what the session already reported.
    const kept = done || report.done || "";
    await applyReport({ report, done: kept, next, at: now });
    await finishSessionReport({ id: report.id, processedHash, done: kept || null, next, at: now });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Session report processing failed", { reportId: report.id, error: message });
    await failSessionReport(report.id, message);
  }
}

// On the scheduler tick: a couple of sessions that went quiet get their log lines.
export async function processDueSessionReports(now = new Date()) {
  const reports = await claimDueSessionReports({
    now,
    quietMs: QUIET_MS,
    maxWaitMs: MAX_WAIT_MS,
    staleClaimMs: STALE_CLAIM_MS,
    maxAttempts: MAX_ATTEMPTS,
    limit: REPORTS_PER_TICK,
  });
  for (const report of reports) await processSessionReport(report, now);
  return { processed: reports.length };
}
