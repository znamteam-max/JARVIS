import { DateTime } from "luxon";

import { askClaudeRelay, isClaudeRelayConfigured } from "@/ai/claudeRelay";
import { canUseOpenAI, getOpenAIClient } from "@/ai/openaiClient";
import { writeAudit } from "@/db/queries/audit";
import {
  getProject,
  listProjectEntries,
  listProjectsNeedingSummary,
  updateProject,
} from "@/db/queries/projects";
import { getUserById } from "@/db/queries/users";
import type { Project, ProjectEntry, User } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getProjectView, ProjectError } from "@/services/projects";

const CLAUDE_TIMEOUT_MS = 60_000;
const MAX_DONE = 60;
const MAX_NOTES = 20;
const MAX_ENTRY_CHARS = 300;
const MAX_SUMMARY_CHARS = 1500;
// Automatic summaries: one project per scheduler tick, and a failed one waits this long.
const AUTO_PER_TICK = 1;
const AUTO_RETRY_MS = 20 * 60 * 1000;

export const PROJECT_SUMMARY_INSTRUCTIONS = `Ты — JARVIS, помощник владельца. По журналу проекта напиши короткую сводку «где остановился», чтобы владелец за 20 секунд вспомнил, что происходит.

Формат — простой текст без заголовков и markdown, 3–6 коротких строк:
Сейчас: одно-два предложения о состоянии проекта.
Сделано: главное из последних шагов — не пересказывай всё подряд, объединяй мелочи.
Дальше: ближайшие открытые шаги, самый важный первым.
Ждём: только если статус «ждёт» или в журнале есть ожидание или блокер.

Правила:
- Только факты из журнала и прежней сводки. Не придумывай сроков, причин и шагов, которых там нет.
- Прежнюю сводку, написанную владельцем, считай достоверной: сохрани её факты, если свежие записи им не противоречат. Свежие записи важнее старых.
- Записи из GitHub и Claude Code бывают на английском и техническими — перескажи их по-русски, человеческими словами.
- Описание из README — только чтобы понять, что это за проект; состояние бери из журнала и локального состояния (незакоммиченные изменения значат, что работа в процессе).
- Если журнал почти пустой, скажи это одной строкой и предложи записать первый шаг.
- Если движения не было больше двух недель, отметь это в строке «Сейчас».
- Пиши по-русски, коротко, без воды и без обращения к владельцу.`;

const STATUS_TEXT: Record<string, string> = {
  active: "в работе",
  waiting: "ждёт",
  paused: "на паузе",
  done: "готов",
};

const SOURCE_TEXT: Record<string, string> = {
  github: " [GitHub]",
  claude_code: " [Claude Code]",
  git: " [git]",
  ai: " [JARVIS]",
};

function clip(text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ENTRY_CHARS ? `${flat.slice(0, MAX_ENTRY_CHARS - 1)}…` : flat;
}

// What the owner's computer last reported: branch and uncommitted work, or "not in git".
function localState(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const local = raw as { git?: unknown; branch?: unknown; dirty?: unknown };
  if (local.git === false) return "Локально: папка без git";
  const parts = [
    typeof local.branch === "string" ? `ветка ${local.branch}` : null,
    typeof local.dirty === "number"
      ? local.dirty
        ? `незакоммиченных изменений: ${local.dirty}`
        : "всё закоммичено"
      : null,
  ].filter(Boolean);
  return parts.length ? `Локально: ${parts.join(", ")}` : null;
}

// Everything the model may rely on, and nothing else.
export function buildProjectSummaryPrompt(params: {
  project: Project;
  entries: ProjectEntry[];
  timezone: string;
  now: Date;
}) {
  const { project, entries, timezone } = params;
  const day = (date: Date) =>
    DateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone).toFormat("dd.LL.yyyy");
  const line = (entry: ProjectEntry, at: Date) =>
    `- ${day(at)}${SOURCE_TEXT[entry.source] ?? ""}: ${clip(entry.text)}`;

  const ahead = entries
    .filter((entry) => entry.kind === "todo" && !entry.closedAt)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const done = entries
    .filter((entry) => entry.kind === "done" || (entry.kind === "todo" && entry.closedAt))
    .map((entry) => ({ entry, at: entry.closedAt ?? entry.occurredAt }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const notes = entries
    .filter((entry) => entry.kind === "note")
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  const meta = project.metadata ?? {};
  const previousBy = meta.summarySource === "manual" ? "владелец" : "JARVIS";
  const readme = typeof meta.readme === "string" && meta.readme.trim() ? meta.readme.trim() : null;
  const sections = [
    `Сегодня: ${day(params.now)}`,
    `Проект: ${project.title}`,
    `Статус: ${STATUS_TEXT[project.status] ?? project.status}`,
    project.status === "waiting" && project.waitingFor ? `Ждём: ${project.waitingFor}` : null,
    project.repo ? `Репозиторий: ${project.repo}` : null,
    localState(meta.local),
    `Последнее движение: ${day(project.lastActivityAt)}`,
    project.summary ? `Прежняя сводка (написал ${previousBy}):\n${project.summary}` : null,
    `Впереди (${ahead.length}):\n${ahead.map((entry) => line(entry, entry.occurredAt)).join("\n") || "- пусто"}`,
    `Сделано (${done.length}${done.length > MAX_DONE ? `, последние ${MAX_DONE}` : ""}):\n${
      done
        .slice(0, MAX_DONE)
        .map(({ entry, at }) => line(entry, at))
        .join("\n") || "- пусто"
    }`,
    readme
      ? `Описание проекта (README):
${readme}`
      : null,
    notes.length
      ? `Заметки:\n${notes
          .slice(0, MAX_NOTES)
          .map((entry) => line(entry, entry.occurredAt))
          .join("\n")}`
      : null,
  ];
  return `${sections.filter(Boolean).join("\n\n")}\n\nНапиши сводку.`;
}

// The model sometimes wraps the answer in markdown anyway; the card shows plain text.
export function cleanSummary(text: string) {
  const cleaned = text
    .replace(/^```[a-z]*\n?|```$/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > MAX_SUMMARY_CHARS
    ? `${cleaned.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : cleaned;
}

type SummaryAnswer = { text: string; engine: "claude" | "openai"; model: string | null };

// Claude on the owner's subscription first; OpenAI when the relay is not set up or fails.
async function writeSummary(user: User, prompt: string): Promise<SummaryAnswer> {
  if (isClaudeRelayConfigured()) {
    try {
      const answer = await askClaudeRelay({
        system: PROJECT_SUMMARY_INSTRUCTIONS,
        prompt,
        model: getEnv().CLAUDE_CHAT_MODEL,
        effort: "low",
        timeoutMs: CLAUDE_TIMEOUT_MS,
      });
      const text = answer.result?.trim();
      if (text) return { text, engine: "claude", model: answer.model };
    } catch (error) {
      logger.warn("Project summary via Claude failed, using OpenAI", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!canUseOpenAI()) throw new ProjectError("summary_failed");
  const model = getEnv().OPENAI_TEXT_MODEL;
  const response = await getOpenAIClient().responses.create({
    model,
    instructions: PROJECT_SUMMARY_INSTRUCTIONS,
    input: prompt,
    max_output_tokens: 700,
  });
  const text = response.output_text?.trim();
  if (!text) throw new ProjectError("summary_failed");
  const usage = response.usage;
  await writeAudit({
    userId: user.id,
    action: "assistant.openai_usage",
    entityType: "project",
    details: {
      capability: "project_summary",
      model: response.model ?? model,
      succeeded: true,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
    },
  }).catch(() => undefined);
  return { text, engine: "openai", model: response.model ?? model };
}

// "Обновить сводку": JARVIS reads the whole log and rewrites "где остановился".
export async function summarizeProject(params: { user: User; projectId: string; now?: Date }) {
  const { user, projectId } = params;
  const now = params.now ?? new Date();
  const project = await getProject(user.id, projectId);
  if (!project) throw new ProjectError("not_found");
  // The summary covers the log as read now: anything added while the model is writing
  // makes it stale.
  const readAt = new Date();
  const entries = await listProjectEntries(user.id, projectId);
  const hasReadme = typeof project.metadata?.readme === "string" && project.metadata.readme.trim();
  if (entries.length === 0 && !project.summary && !hasReadme) {
    throw new ProjectError("nothing_to_summarize");
  }

  let answer: SummaryAnswer;
  try {
    answer = await writeSummary(
      user,
      buildProjectSummaryPrompt({ project, entries, timezone: user.timezone, now }),
    );
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    logger.warn("Project summary failed", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ProjectError("summary_failed");
  }
  const summary = cleanSummary(answer.text);
  if (!summary) throw new ProjectError("summary_failed");

  await updateProject(
    user.id,
    projectId,
    { summary },
    {
      touch: false,
      metadata: {
        summarySource: "ai",
        summaryAt: readAt.toISOString(),
        summaryModel: answer.model,
        summaryEngine: answer.engine,
        // With the relay set up, an OpenAI summary means Claude was down.
        summaryFallback: answer.engine === "openai" && isClaudeRelayConfigured(),
      },
    },
  );
  return getProjectView(user.id, projectId);
}

// On the scheduler tick: a project with new lines (commits, a Claude Code session, an
// import) or no summary yet gets "где остановился" written by itself, so the list always
// shows where things stand. Summaries the owner wrote are left for them to update.
export async function summarizeStaleProjects(now = new Date()) {
  const due = await listProjectsNeedingSummary({
    retryBefore: new Date(now.getTime() - AUTO_RETRY_MS),
    limit: AUTO_PER_TICK,
  });
  let written = 0;
  for (const project of due) {
    await updateProject(
      project.userId,
      project.id,
      {},
      { touch: false, metadata: { summaryAttemptAt: now.toISOString() } },
    );
    const user = await getUserById(project.userId);
    if (!user) continue;
    try {
      await summarizeProject({ user, projectId: project.id, now });
      written += 1;
    } catch (error) {
      logger.warn("Automatic project summary failed", {
        projectId: project.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { checked: due.length, written };
}
