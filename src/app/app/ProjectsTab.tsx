"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  EntryKind,
  ProjectDetailView,
  ProjectEntryView,
  ProjectListView,
  ProjectStatus,
} from "@/services/projects";

import { confirmAction } from "./confirmAction";
import styles from "./miniapp.module.css";

type Api = (path: string, init?: RequestInit) => Promise<Record<string, unknown> | null>;
type Filter = "all" | ProjectStatus;

const STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "В работе",
  waiting: "Ждёт",
  paused: "Пауза",
  done: "Готово",
};

const KIND_LABELS: Record<EntryKind, string> = {
  done: "Сделал",
  todo: "Впереди",
  note: "Заметка",
};

const KIND_PLACEHOLDERS: Record<EntryKind, string> = {
  done: "Что сделано: «подключил оплату», «отправил макет на согласование»",
  todo: "Что дальше: «дописать тесты», «созвониться с подрядчиком»",
  note: "Контекст, решение, ссылка — чтобы вспомнить потом",
};

const SOURCE_LABELS: Record<string, string> = {
  github: "GitHub",
  claude_code: "Claude Code",
  git: "git",
  ai: "JARVIS",
};

const ERRORS: Record<string, string> = {
  not_found: "Этот проект уже изменился. Обнови список.",
  repo_taken: "Этот репозиторий уже привязан к другому проекту.",
  invalid_repo: "Репозиторий — в виде owner/name или ссылкой на GitHub.",
  invalid: "Проверь поля: у проекта должно быть название.",
  nothing_to_summarize: "Сначала запиши хотя бы один шаг — из пустого журнала сводку не собрать.",
  summary_failed: "JARVIS сейчас не смог написать сводку. Попробуй через минуту.",
  no_repo: "Сначала привяжи репозиторий: «Изменить» → GitHub.",
};

const GITHUB_ERRORS: Record<string, string> = {
  repo_not_found: "GitHub не видит репозиторий: проверь название или доступ токена.",
  bad_token: "GitHub не принял токен — обнови GITHUB_TOKEN в настройках Vercel.",
  rate_limited: "GitHub временно ограничил запросы — подтяну коммиты позже.",
  github_failed: "GitHub не ответил — подтяну коммиты позже.",
};

const DONE_PREVIEW = 8;

function errorText(body: Record<string, unknown> | null) {
  return (
    ERRORS[typeof body?.error === "string" ? body.error : ""] ?? "Не получилось. Попробуй ещё раз."
  );
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Inside Telegram a link opens in its browser; elsewhere in a new tab.
function openExternal(event: React.MouseEvent<HTMLAnchorElement>) {
  const app = window.Telegram?.WebApp;
  if (app?.initData && app.openLink) {
    event.preventDefault();
    app.openLink(event.currentTarget.href);
  }
}

// "сегодня в 14:05" for a sync time; the plain day otherwise.
function agoTime(iso: string) {
  const day = ago(iso);
  return day === "сегодня"
    ? `сегодня в ${new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
    : day;
}

// "сегодня", "вчера", "3 дн. назад", then a plain date.
function ago(iso: string) {
  const date = new Date(iso);
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн. назад`;
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export function ProjectsTab({ api }: { api: Api }) {
  const [projects, setProjects] = useState<ProjectListView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api("/api/miniapp/projects").then((body) => {
        if (Array.isArray(body?.projects)) setProjects(body.projects as ProjectListView[]);
        else setError(errorText(body));
      }),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (openId) {
    return (
      <ProjectDetail
        id={openId}
        api={api}
        back={() => {
          setOpenId(null);
          void load();
        }}
        deleted={(list) => {
          setProjects(list);
          setOpenId(null);
        }}
      />
    );
  }

  const counts = (projects ?? []).reduce<Record<string, number>>((acc, project) => {
    acc[project.status] = (acc[project.status] ?? 0) + 1;
    return acc;
  }, {});
  const visible = (projects ?? []).filter(
    (project) => filter === "all" || project.status === filter,
  );

  return (
    <>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.caption}>что в работе и где остановился</span>
          <h1 className={styles.title}>Проекты</h1>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setCreating((current) => !current)}
          >
            {creating ? "Закрыть" : "Новый"}
          </button>
        </div>
      </div>
      {error ? <div className={styles.error}>{error}</div> : null}
      {creating ? (
        <ProjectCreateForm
          api={api}
          done={(project) => {
            setCreating(false);
            setOpenId(project.id);
          }}
        />
      ) : null}
      {projects?.length ? (
        <div className={styles.chips} role="group" aria-label="Фильтр по статусу">
          {(["all", "active", "waiting", "paused", "done"] as Filter[]).map((id) =>
            id === "all" || counts[id] ? (
              <button
                key={id}
                type="button"
                className={filter === id ? styles.chipActive : styles.chip}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {id === "all" ? `Все ${projects.length}` : `${STATUS_LABELS[id]} ${counts[id]}`}
              </button>
            ) : null,
          )}
        </div>
      ) : null}
      {projects === null && !error ? <span className={styles.caption}>Загружаю…</span> : null}
      {projects?.length === 0 && !creating ? (
        <div className={styles.card}>
          <span>
            Здесь живут все проекты: что сделано, что впереди и чего ждём. Нажми «Новый» и добавь
            первый — потом записывай по строчке после каждого шага, и вспоминать не придётся.
          </span>
        </div>
      ) : null}
      {visible.map((project) => (
        <button
          key={project.id}
          type="button"
          className={styles.projectCard}
          onClick={() => setOpenId(project.id)}
        >
          <span className={styles.header}>
            <span className={styles.sectionTitle}>{project.title}</span>
            <span className={styles[`status_${project.status}`]}>
              {STATUS_LABELS[project.status]}
            </span>
          </span>
          {project.status === "waiting" && project.waitingFor ? (
            <span className={styles.detail}>Ждём: {project.waitingFor}</span>
          ) : null}
          {project.summaryLine ? (
            <span className={styles.projectState}>{project.summaryLine}</span>
          ) : null}
          {project.lastDone ? (
            <span className={styles.projectLine}>
              ✓ {project.lastDone.text}{" "}
              <span className={styles.detail}>· {ago(project.lastDone.at)}</span>
            </span>
          ) : null}
          <span className={styles.detail}>
            {project.openTodos ? `Впереди: ${project.openTodos}` : "Впереди пусто"} · обновлён{" "}
            {ago(project.lastActivityAt)}
          </span>
        </button>
      ))}
    </>
  );
}

function ProjectCreateForm({
  api,
  done,
}: {
  api: Api;
  done: (project: ProjectDetailView) => void;
}) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    const body = await api(
      "/api/miniapp/projects",
      json("POST", { action: "create", title, status, repo: repo || null }),
    );
    setBusy(false);
    if (body?.ok && body.project) done(body.project as ProjectDetailView);
    else setError(errorText(body));
  }

  return (
    <section className={styles.card} aria-label="Новый проект">
      <input
        className={styles.input}
        placeholder="Название проекта"
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
      />
      <StatusChips value={status} onChange={setStatus} />
      <input
        className={styles.input}
        placeholder="GitHub: owner/name (необязательно)"
        value={repo}
        maxLength={300}
        autoCapitalize="off"
        onChange={(event) => setRepo(event.target.value)}
      />
      {error ? <span className={styles.caption}>{error}</span> : null}
      <button
        type="button"
        className={styles.primary}
        disabled={busy || !title.trim()}
        onClick={() => void submit()}
      >
        Создать
      </button>
    </section>
  );
}

function StatusChips({
  value,
  onChange,
  disabled,
}: {
  value: ProjectStatus;
  onChange: (status: ProjectStatus) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.chips} role="group" aria-label="Статус">
      {(Object.keys(STATUS_LABELS) as ProjectStatus[]).map((id) => (
        <button
          key={id}
          type="button"
          className={value === id ? styles.chipActive : styles.chip}
          aria-pressed={value === id}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          {STATUS_LABELS[id]}
        </button>
      ))}
    </div>
  );
}

function ProjectDetail({
  id,
  api,
  back,
  deleted,
}: {
  id: string;
  api: Api;
  back: () => void;
  deleted: (projects: ProjectListView[]) => void;
}) {
  const [project, setProject] = useState<ProjectDetailView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const show = useCallback((body: Record<string, unknown> | null) => {
    if (body?.ok && body.project) {
      setProject(body.project as ProjectDetailView);
      return true;
    }
    setError(errorText(body));
    return false;
  }, []);

  const run = useCallback(
    async (init?: RequestInit, path = "/api/miniapp/projects") => {
      setBusy(true);
      setError(null);
      const body = await api(path, init);
      setBusy(false);
      return show(body);
    },
    [api, show],
  );

  useEffect(() => {
    void api(`/api/miniapp/projects?id=${id}`).then(show);
  }, [api, id, show]);

  const patch = (fields: Record<string, unknown>) => run(json("PATCH", { id, ...fields }));

  async function syncGithub() {
    setSyncing(true);
    await run(json("POST", { action: "github_sync", projectId: id }));
    setSyncing(false);
  }

  async function summarize() {
    setEditingSummary(false);
    setSummarizing(true);
    await run(json("POST", { action: "summarize", projectId: id }));
    setSummarizing(false);
  }

  async function remove() {
    if (!project) return;
    if (!(await confirmAction(`Удалить проект «${project.title}» вместе со всей историей?`))) {
      return;
    }
    setBusy(true);
    const body = await api(`/api/miniapp/projects?id=${id}`, { method: "DELETE" });
    setBusy(false);
    if (body?.ok && Array.isArray(body.projects)) deleted(body.projects as ProjectListView[]);
    else setError(errorText(body));
  }

  const doneShown = project
    ? showAllDone
      ? project.done
      : project.done.slice(0, DONE_PREVIEW)
    : [];

  return (
    <>
      <div className={styles.header}>
        <button type="button" className={styles.linkButton} onClick={back}>
          ← Проекты
        </button>
        {project ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? "Закрыть" : "Изменить"}
          </button>
        ) : null}
      </div>
      {error ? <div className={styles.error}>{error}</div> : null}
      {!project && !error ? <span className={styles.caption}>Загружаю…</span> : null}
      {project ? (
        <>
          <div className={styles.headerText}>
            <span className={styles.caption}>
              {project.repo ? `${project.repo} · ` : ""}обновлён {ago(project.lastActivityAt)}
            </span>
            <h1 className={styles.title}>{project.title}</h1>
          </div>
          {project.github ? (
            <div className={styles.header}>
              <span className={project.github.error ? styles.warnText : styles.caption}>
                {project.github.error
                  ? (GITHUB_ERRORS[project.github.error] ?? GITHUB_ERRORS.github_failed)
                  : project.github.syncedAt
                    ? `GitHub: коммиты подтянуты ${agoTime(project.github.syncedAt)}`
                    : "GitHub: коммиты ещё не подтягивались"}
              </span>
              <button
                type="button"
                className={styles.linkButton}
                disabled={busy}
                onClick={() => void syncGithub()}
              >
                {syncing ? "Подтягиваю…" : "Обновить"}
              </button>
            </div>
          ) : null}
          {editing ? (
            <ProjectEditForm
              project={project}
              busy={busy}
              save={async (fields) => {
                if (await patch(fields)) setEditing(false);
              }}
              remove={() => void remove()}
            />
          ) : null}
          <StatusChips
            value={project.status}
            disabled={busy}
            onChange={(status) => void patch({ status })}
          />
          {project.status === "waiting" ? (
            <WaitingFor
              key={project.waitingFor ?? ""}
              value={project.waitingFor}
              busy={busy}
              save={(waitingFor) => void patch({ waitingFor })}
            />
          ) : null}

          <section className={styles.card} aria-label="Где остановился">
            <div className={styles.header}>
              <h2 className={styles.sectionTitle}>Где остановился</h2>
              <span className={styles.rowActions}>
                {project.summary ||
                project.ahead.length + project.done.length + project.notes.length ? (
                  <button
                    type="button"
                    className={styles.linkButton}
                    disabled={busy}
                    onClick={() => void summarize()}
                  >
                    {summarizing ? "Пишу…" : project.summary ? "Обновить" : "Собрать"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={summarizing}
                  onClick={() => setEditingSummary((current) => !current)}
                >
                  {editingSummary ? "Закрыть" : project.summary ? "Изменить" : "Написать"}
                </button>
              </span>
            </div>
            {summarizing ? (
              <span className={styles.caption} role="status">
                JARVIS читает журнал проекта — это может занять до минуты.
              </span>
            ) : null}
            {editingSummary ? (
              <SummaryForm
                value={project.summary}
                busy={busy}
                save={async (summary) => {
                  if (await patch({ summary })) setEditingSummary(false);
                }}
              />
            ) : project.summary ? (
              <>
                <span className={styles.projectSummary}>{project.summary}</span>
                <span className={styles.detail}>
                  {project.summaryBy === "ai"
                    ? `JARVIS${project.summaryModel ? ` · ${project.summaryModel}` : ""}`
                    : "вручную"}
                  {project.summaryAt ? ` · ${ago(project.summaryAt)}` : ""}
                </span>
                {project.summaryStale && !summarizing ? (
                  <span className={styles.caption}>
                    После сводки появились новые записи — нажми «Обновить».
                  </span>
                ) : null}
              </>
            ) : (
              <span className={styles.caption}>
                Пара строк о том, в каком состоянии проект: что работает, что сломано, на чём
                остановился. Напиши сам или нажми «Собрать» — JARVIS сведёт журнал.
              </span>
            )}
          </section>

          <section className={styles.card} aria-label="Впереди">
            <h2 className={styles.sectionTitle}>Впереди · {project.ahead.length}</h2>
            {project.ahead.length ? (
              <div className={styles.rows}>
                {project.ahead.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    busy={busy}
                    run={run}
                    primary={{
                      label: "Готово",
                      action: () => void run(json("PATCH", { entryId: entry.id, done: true })),
                    }}
                  />
                ))}
              </div>
            ) : (
              <span className={styles.caption}>Следующих шагов пока нет — добавь ниже.</span>
            )}
          </section>

          <section className={styles.card} aria-label="Сделано">
            <h2 className={styles.sectionTitle}>Сделано · {project.done.length}</h2>
            {doneShown.length ? (
              <div className={styles.rows}>
                {doneShown.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    busy={busy}
                    run={run}
                    primary={
                      entry.kind === "todo"
                        ? {
                            label: "Вернуть",
                            action: () =>
                              void run(json("PATCH", { entryId: entry.id, done: false })),
                          }
                        : null
                    }
                  />
                ))}
              </div>
            ) : (
              <span className={styles.caption}>Пока ничего не записано.</span>
            )}
            {project.done.length > DONE_PREVIEW ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setShowAllDone((current) => !current)}
              >
                {showAllDone ? "Свернуть" : `Показать все (${project.done.length})`}
              </button>
            ) : null}
          </section>

          {project.notes.length ? (
            <section className={styles.card} aria-label="Заметки">
              <h2 className={styles.sectionTitle}>Заметки</h2>
              <div className={styles.rows}>
                {project.notes.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} busy={busy} run={run} primary={null} />
                ))}
              </div>
            </section>
          ) : null}

          <EntryComposer
            busy={busy}
            add={(kind, text) =>
              run(json("POST", { action: "entry", projectId: project.id, kind, text }))
            }
          />
        </>
      ) : null}
    </>
  );
}

function EntryRow({
  entry,
  busy,
  run,
  primary,
}: {
  entry: ProjectEntryView;
  busy: boolean;
  run: (init?: RequestInit, path?: string) => Promise<boolean>;
  primary: { label: string; action: () => void } | null;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  const source = SOURCE_LABELS[entry.source];

  async function remove() {
    if (await confirmAction("Удалить эту запись?")) {
      void run({ method: "DELETE" }, `/api/miniapp/projects?entryId=${entry.id}`);
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.header}>
        <span className={styles.projectLine}>{entry.text}</span>
        <span className={styles.rowActions}>
          {primary ? (
            <button
              type="button"
              className={styles.linkButton}
              disabled={busy}
              onClick={primary.action}
            >
              {primary.label}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.linkButton}
            aria-label={editing ? "Закрыть" : "Изменить запись"}
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? "Закрыть" : "…"}
          </button>
        </span>
      </div>
      <span className={styles.detail}>
        {ago(entry.at)}
        {source ? ` · ${source}` : ""}
        {entry.url ? (
          <>
            {" · "}
            <a
              className={styles.inlineLink}
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              onClick={openExternal}
            >
              открыть
            </a>
          </>
        ) : null}
      </span>
      {editing ? (
        <div className={styles.editItem}>
          <textarea
            className={styles.textarea}
            value={text}
            maxLength={2000}
            onChange={(event) => setText(event.target.value)}
          />
          <div className={styles.chips}>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy || !text.trim() || text === entry.text}
              onClick={() =>
                void run(json("PATCH", { entryId: entry.id, text })).then(
                  (ok) => ok && setEditing(false),
                )
              }
            >
              Сохранить
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => void remove()}
            >
              Удалить
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EntryComposer({
  busy,
  add,
}: {
  busy: boolean;
  add: (kind: EntryKind, text: string) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<EntryKind>("done");
  const [text, setText] = useState("");

  async function submit() {
    if (!text.trim() || busy) return;
    if (await add(kind, text)) setText("");
  }

  return (
    <section className={styles.card} aria-label="Добавить запись">
      <div className={styles.chips} role="group" aria-label="Тип записи">
        {(Object.keys(KIND_LABELS) as EntryKind[]).map((id) => (
          <button
            key={id}
            type="button"
            className={kind === id ? styles.chipActive : styles.chip}
            aria-pressed={kind === id}
            onClick={() => setKind(id)}
          >
            {KIND_LABELS[id]}
          </button>
        ))}
      </div>
      <textarea
        className={styles.textarea}
        placeholder={KIND_PLACEHOLDERS[kind]}
        value={text}
        maxLength={2000}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className={styles.primary}
        disabled={busy || !text.trim()}
        onClick={() => void submit()}
      >
        Добавить
      </button>
    </section>
  );
}

function WaitingFor({
  value,
  busy,
  save,
}: {
  value: string | null;
  busy: boolean;
  save: (value: string) => void;
}) {
  const [text, setText] = useState(value ?? "");
  return (
    <div className={styles.field}>
      <input
        className={styles.input}
        placeholder="Чего ждём: ответа заказчика, ревью, оплаты…"
        value={text}
        maxLength={300}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className={styles.secondary}
        disabled={busy || text === (value ?? "")}
        onClick={() => save(text)}
      >
        OK
      </button>
    </div>
  );
}

function SummaryForm({
  value,
  busy,
  save,
}: {
  value: string | null;
  busy: boolean;
  save: (value: string) => Promise<void>;
}) {
  const [text, setText] = useState(value ?? "");
  return (
    <>
      <textarea
        className={styles.textarea}
        placeholder="Например: оплата подключена, осталось письмо-подтверждение; жду ключи от заказчика."
        value={text}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className={styles.secondary}
        disabled={busy || text === (value ?? "")}
        onClick={() => void save(text)}
      >
        Сохранить
      </button>
    </>
  );
}

function ProjectEditForm({
  project,
  busy,
  save,
  remove,
}: {
  project: ProjectDetailView;
  busy: boolean;
  save: (fields: { title: string; repo: string | null }) => Promise<void>;
  remove: () => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [repo, setRepo] = useState(project.repo ?? "");
  return (
    <section className={styles.card} aria-label="Изменить проект">
      <input
        className={styles.input}
        placeholder="Название проекта"
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
      />
      <input
        className={styles.input}
        placeholder="GitHub: owner/name (необязательно)"
        value={repo}
        maxLength={300}
        autoCapitalize="off"
        onChange={(event) => setRepo(event.target.value)}
      />
      <div className={styles.chips}>
        <button
          type="button"
          className={styles.secondary}
          disabled={busy || !title.trim()}
          onClick={() => void save({ title, repo: repo || null })}
        >
          Сохранить
        </button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={remove}>
          Удалить проект
        </button>
      </div>
    </section>
  );
}
