"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

import type { MiniAppSummary } from "@/services/miniappSummary";

import styles from "./miniapp.module.css";

type Tab = "today" | "plan" | "food" | "fitness";
type Mode = "telegram" | "browser";
type InstallPrompt = Event & { prompt(): Promise<void> };
type TelegramWebApp = {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  addToHomeScreen?(): void;
  showConfirm?(message: string, callback: (confirmed: boolean) => void): void;
};
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const ERRORS: Record<string, string> = {
  unauthorized: "Открой приложение из Telegram: кнопка JARVIS в чате с ботом.",
  not_food: "На фото не видно еды. Попробуй ещё раз или добавь подпись.",
  estimation_failed: "Не получилось посчитать калории. Попробуй ещё раз чуть позже.",
  photo_missing_or_too_large: "Фото не загрузилось или слишком большое.",
  reminders_not_understood:
    "Не понял напоминание. Напиши, например: «за час и за 15 минут» или «каждый час с 8 до 12».",
  not_found: "Этот пункт уже изменился. Обнови расписание.",
  photo_delete_failed: "Не получилось удалить фото. Попробуй ещё раз.",
  not_food_text: "Не понял, что за еда. Напиши, например: «гречка с курицей, тарелка».",
  invalid_time: "Время еды — не позже, чем сейчас, и не раньше, чем неделю назад.",
};

export function MiniApp() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [summary, setSummary] = useState<MiniAppSummary | null>(null);
  const [tab, setTab] = useState<Tab>("today");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);

  const initDataRef = useRef("");
  const startedRef = useRef(false);

  // Chrome/Android offers its own install dialog; keep the event for the "Установить" button.
  useEffect(() => {
    const keep = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", keep);
    return () => window.removeEventListener("beforeinstallprompt", keep);
  }, []);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        ...init,
        headers: { ...(init?.headers ?? {}), "x-telegram-init-data": initDataRef.current },
      });
      // Outside Telegram a 401 just means this device has not been approved yet.
      if (response.status === 401 && !initDataRef.current) {
        setSummary(null);
        setNeedsLogin(true);
        return false;
      }
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        summary?: MiniAppSummary;
      };
      if (!response.ok || !body.ok || !body.summary) {
        throw new Error(ERRORS[body.error ?? ""] ?? "Что-то пошло не так. Попробуй ещё раз.");
      }
      setSummary(body.summary);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  // Runs once the Telegram script is ready (or failed to load). Inside Telegram the launch
  // data signs every request; in a browser the approved device cookie does.
  const connect = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const app = window.Telegram?.WebApp;
    if (app?.initData) {
      app.ready();
      app.expand();
      app.setHeaderColor?.("#0F1218");
      app.setBackgroundColor?.("#0F1218");
      initDataRef.current = app.initData;
    }
    setMode(app?.initData ? "telegram" : "browser");
    void call("/api/miniapp/summary");
  }, [call]);

  const logout = useCallback(async () => {
    if (!(await confirmAction("Выйти на этом устройстве? Войти снова можно через Telegram."))) {
      return;
    }
    await fetch("/api/auth/web-login", { method: "DELETE" }).catch(() => undefined);
    setSummary(null);
    setNeedsLogin(true);
  }, []);

  return (
    <div className={styles.app}>
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        onReady={connect}
        onError={connect}
      />
      <div className={styles.content}>
        {needsLogin ? (
          <LoginScreen
            onDone={() => {
              setNeedsLogin(false);
              void call("/api/miniapp/summary");
            }}
          />
        ) : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        {!summary && !needsLogin && !error ? <div className={styles.caption}>Загружаю…</div> : null}
        {summary && tab === "today" ? (
          <TodayTab
            summary={summary}
            openPlan={() => setTab("plan")}
            call={call}
            busy={busy}
            mode={mode}
            install={
              installPrompt
                ? () => {
                    void installPrompt.prompt();
                    setInstallPrompt(null);
                  }
                : null
            }
            logout={() => void logout()}
          />
        ) : null}
        {summary && tab === "plan" ? <PlanTab summary={summary} call={call} busy={busy} /> : null}
        {summary && tab === "food" ? <FoodTab summary={summary} busy={busy} call={call} /> : null}
        {summary && tab === "fitness" ? <FitnessTab summary={summary} /> : null}
      </div>
      <nav className={needsLogin ? styles.hidden : styles.tabbar} aria-label="Разделы">
        {(
          [
            ["today", "Сегодня", "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 8v4l3 2"],
            ["plan", "Расписание", "M4 6h16M4 12h16M4 18h10"],
            ["food", "Питание", "M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-2 6 0 8v10"],
            ["fitness", "Тренировки", "M3 12h4l3-7 4 14 3-7h4"],
          ] as Array<[Tab, string, string]>
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? styles.tabActive : styles.tab}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d={icon} />
            </svg>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function kcal(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

function TodayTab({
  summary,
  openPlan,
  call,
  busy,
  mode,
  install,
  logout,
}: {
  summary: MiniAppSummary;
  openPlan: () => void;
  call: Call;
  busy: boolean;
  mode: Mode | null;
  install: (() => void) | null;
  logout: () => void;
}) {
  const { budget, eaten, goals, workoutCalories } = summary;
  const circumference = 2 * Math.PI * 84;
  const near = summary.plan.filter((section) => /^(Сейчас|Сегодня|Не закрыто)/.test(section.title));
  const macros = [
    ["Белки", eaten.proteinG, goals.proteinG, "var(--protein)"],
    ["Жиры", eaten.fatG, goals.fatG, "var(--fat)"],
    ["Углеводы", eaten.carbsG, goals.carbsG, "var(--carbs)"],
  ] as const;
  const app = typeof window === "undefined" ? undefined : window.Telegram?.WebApp;
  return (
    <>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.caption}>{summary.dateLabel}</span>
          <h1 className={styles.title}>Сегодня</h1>
        </div>
        {mode === "telegram" && app?.addToHomeScreen ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => app.addToHomeScreen?.()}
          >
            На экран «Домой»
          </button>
        ) : null}
      </div>
      <div className={styles.ringCard}>
        <div className={styles.ring}>
          <svg
            width="140"
            height="140"
            viewBox="0 0 200 200"
            role="img"
            aria-label={`Съедено ${budget.eaten} из ${budget.target} ккал`}
          >
            <circle cx="100" cy="100" r="84" fill="none" stroke="var(--line)" strokeWidth="16" />
            <circle
              cx="100"
              cy="100"
              r="84"
              fill="none"
              stroke={budget.remaining < 0 ? "var(--fat)" : "var(--accent)"}
              strokeWidth="16"
              strokeLinecap="round"
              strokeDasharray={`${budget.progress * circumference} ${circumference}`}
              transform="rotate(-90 100 100)"
            />
          </svg>
          <div className={styles.ringCenter}>
            <span className={styles.ringValue}>{kcal(Math.abs(budget.remaining))}</span>
            <span className={styles.caption}>
              {budget.remaining < 0 ? "перебор ккал" : "осталось ккал"}
            </span>
          </div>
        </div>
        <div className={styles.ledger}>
          <div className={styles.ledgerRow}>
            <span className={styles.caption}>Цель</span>
            <span>{kcal(goals.calories)}</span>
          </div>
          <div className={styles.ledgerRow}>
            <span className={styles.caption}>Еда</span>
            <span>− {kcal(budget.eaten)}</span>
          </div>
          <div className={styles.ledgerRow}>
            <span className={styles.caption}>Тренировки</span>
            <span>+ {kcal(budget.bonus)}</span>
          </div>
          <div className={styles.ledgerTotal}>
            <span>Осталось</span>
            <span>{kcal(budget.remaining)}</span>
          </div>
          {workoutCalories ? (
            <span className={styles.detail}>
              сожжено {kcal(workoutCalories)}, в норму идёт {goals.workoutPercent}%
            </span>
          ) : null}
        </div>
      </div>
      <div className={styles.macros}>
        {macros.map(([label, value, goal, color]) => (
          <div key={label} className={styles.macro}>
            <span className={styles.caption}>{label}</span>
            <span className={styles.macroValue}>
              {value} <span className={styles.caption}>/ {goal} г</span>
            </span>
            <div className={styles.bar}>
              <div
                className={styles.barFill}
                style={{
                  width: `${Math.min(100, (value / Math.max(goal, 1)) * 100)}%`,
                  background: color,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>Ближайшие часы</h2>
        <button type="button" className={styles.linkButton} onClick={openPlan}>
          Всё расписание
        </button>
      </div>
      {near.length ? (
        near.map((section) => (
          <PlanSectionCard key={section.title} section={section} call={call} busy={busy} />
        ))
      ) : (
        <div className={styles.card}>
          <span className={styles.caption}>На сегодня в плане ничего нет.</span>
        </div>
      )}
      {mode === "browser" ? <DeviceCard install={install} logout={logout} /> : null}
    </>
  );
}

// Browser mode only: how to put the app on the home screen, and a way out.
function DeviceCard({ install, logout }: { install: (() => void) | null; logout: () => void }) {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  return (
    <section className={styles.card} aria-label="Это устройство">
      {!standalone ? (
        <>
          <h2 className={styles.sectionTitle}>Установить как приложение</h2>
          {install ? (
            <button type="button" className={styles.primary} onClick={install}>
              Установить JARVIS
            </button>
          ) : (
            <span className={styles.caption}>
              {ios
                ? "В Safari: кнопка «Поделиться» → «На экран „Домой“». Иконка JARVIS откроет приложение без Telegram."
                : "В меню браузера: «Установить приложение» или «Добавить на главный экран»."}
            </span>
          )}
        </>
      ) : null}
      <button type="button" className={styles.linkButton} onClick={logout}>
        Выйти на этом устройстве
      </button>
    </section>
  );
}

// Outside Telegram: the device asks, the owner taps "Разрешить" in the bot, the app opens.
function LoginScreen({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"start" | "waiting" | "denied">("start");
  const [code, setCode] = useState<string | null>(null);
  const [bot, setBot] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const pollingRef = useRef(false);

  const poll = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const deadline = Date.now() + 10 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const body = (await fetch("/api/auth/web-login", { cache: "no-store" })
          .then((response) => response.json())
          .catch(() => null)) as { state?: string } | null;
        if (body?.state === "active") return onDone();
        if (body?.state === "denied") return setStep("denied");
        if (body?.state === "none" || body?.state === "expired") break;
      }
      setStep("start");
      setMessage("Запрос истёк. Нажми «Войти» ещё раз.");
    } finally {
      pollingRef.current = false;
    }
  }, [onDone]);

  // A request may already be waiting (the app was reopened after switching to Telegram).
  useEffect(() => {
    void fetch("/api/auth/web-login", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { state?: string; code?: string | null }) => {
        if (body.state !== "pending") return;
        setCode(body.code ?? null);
        setStep("waiting");
        void poll();
      })
      .catch(() => undefined);
  }, [poll]);

  async function start() {
    setSending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/web-login", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        code?: string;
        botUsername?: string | null;
      };
      if (!response.ok || !body.ok) {
        setMessage(
          body.error === "too_many_requests"
            ? "Слишком много попыток входа. Подожди 10 минут."
            : "Не получилось отправить запрос в Telegram. Попробуй ещё раз.",
        );
        return;
      }
      setCode(body.code ?? null);
      setBot(body.botUsername ?? null);
      setStep("waiting");
      void poll();
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={styles.card} aria-label="Вход">
      <h1 className={styles.title}>JARVIS</h1>
      {step === "waiting" ? (
        <>
          <span className={styles.caption}>Код подтверждения</span>
          <span className={styles.ringValue} style={{ fontSize: 40, letterSpacing: 6 }}>
            {code}
          </span>
          <span>
            Открой Telegram: бот прислал запрос на вход с этим кодом. Нажми «✅ Разрешить» — и
            приложение откроется здесь само.
          </span>
          {bot ? (
            <a className={styles.secondary} href={`https://t.me/${bot}`} style={linkButtonStyle}>
              Открыть Telegram
            </a>
          ) : null}
          <span className={styles.caption}>Жду подтверждения…</span>
        </>
      ) : (
        <>
          <span>
            {step === "denied"
              ? "Вход отклонён в Telegram."
              : "Приложение работает и без Telegram. Чтобы войти на этом устройстве, один раз подтверди вход в чате с ботом."}
          </span>
          <button
            type="button"
            className={styles.primary}
            disabled={sending}
            onClick={() => void start()}
          >
            {sending
              ? "Отправляю…"
              : step === "denied"
                ? "Попробовать снова"
                : "Войти через Telegram"}
          </button>
        </>
      )}
      {message ? <span className={styles.error}>{message}</span> : null}
    </section>
  );
}

const linkButtonStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  textDecoration: "none",
} as const;

type PlanSection = MiniAppSummary["plan"][number];
type EditableItem = NonNullable<PlanSection["rows"][number]["item"]>;

function PlanSectionCard({
  section,
  call,
  busy,
}: {
  section: PlanSection;
  call: Call;
  busy: boolean;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  return (
    <section className={styles.card} aria-label={section.title}>
      <h2 className={styles.sectionTitle}>{section.title}</h2>
      {section.rows.length ? (
        <div className={styles.rows}>
          {section.rows.map((row) => (
            <div key={`${row.number}-${row.text}`} className={styles.row}>
              <div className={styles.header}>
                <span>{row.text}</span>
                {row.item ? (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setEditing(editing === row.number ? null : row.number)}
                  >
                    {editing === row.number ? "Закрыть" : "Изменить"}
                  </button>
                ) : null}
              </div>
              {row.details.map((detail) => (
                <span key={detail} className={styles.detail}>
                  {detail}
                </span>
              ))}
              {row.item && editing === row.number ? (
                <EditItemForm
                  item={row.item}
                  details={row.details}
                  call={call}
                  busy={busy}
                  close={() => setEditing(null)}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {section.note ? <span className={styles.caption}>{section.note}</span> : null}
    </section>
  );
}

function EditItemForm({
  item,
  details,
  call,
  busy,
  close,
}: {
  item: EditableItem;
  details: string[];
  call: Call;
  busy: boolean;
  close: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [start, setStart] = useState(item.startLocal ?? "");
  const [end, setEnd] = useState(item.endLocal ?? "");
  const [due, setDue] = useState(item.dueLocal ?? "");
  const [reminders, setReminders] = useState("");
  const isEvent = ["event", "training", "tentative_event"].includes(item.kind);
  const id = (field: string) => `${field}-${item.id}`;

  async function save() {
    const body: Record<string, unknown> = { id: item.id };
    if (title.trim() && title.trim() !== item.title) body.title = title.trim();
    if (isEvent && start && (start !== item.startLocal || end !== (item.endLocal ?? ""))) {
      body.startLocal = start;
      if (end) body.endLocal = end;
    }
    if (!isEvent && due !== (item.dueLocal ?? "")) body.dueLocal = due || null;
    if (reminders.trim()) body.remindersText = reminders.trim();
    const saved = await call("/api/miniapp/item", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (saved) close();
  }

  async function remove() {
    const question = isEvent
      ? `Удалить «${item.title}»? Напоминания тоже удалятся, а событие исчезнет из Яндекс.Календаря.`
      : `Удалить «${item.title}» вместе с напоминаниями?`;
    if (!(await confirmAction(question))) return;
    if (await call(`/api/miniapp/item?id=${item.id}`, { method: "DELETE" })) close();
  }

  return (
    <div className={styles.card} style={{ background: "var(--surface2)", marginTop: 8 }}>
      <label className={styles.caption} htmlFor={id("title")}>
        Название
      </label>
      <input
        id={id("title")}
        className={styles.input}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      {isEvent ? (
        <>
          <label className={styles.caption} htmlFor={id("start")}>
            Начало
          </label>
          <input
            id={id("start")}
            className={styles.input}
            type="datetime-local"
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
          <label className={styles.caption} htmlFor={id("end")}>
            Конец
          </label>
          <input
            id={id("end")}
            className={styles.input}
            type="datetime-local"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </>
      ) : (
        <>
          <label className={styles.caption} htmlFor={id("due")}>
            Дедлайн
          </label>
          <div className={styles.ingredient}>
            <input
              id={id("due")}
              className={styles.input}
              type="datetime-local"
              value={due}
              onChange={(event) => setDue(event.target.value)}
            />
            {due ? (
              <button type="button" className={styles.secondary} onClick={() => setDue("")}>
                Без дедлайна
              </button>
            ) : null}
          </div>
        </>
      )}
      <span className={styles.caption}>Напоминания сейчас</span>
      {details.length ? (
        details.map((detail) => (
          <span key={detail} className={styles.detail}>
            {detail}
          </span>
        ))
      ) : (
        <span className={styles.detail}>нет</span>
      )}
      <label className={styles.caption} htmlFor={id("reminders")}>
        Новые напоминания
      </label>
      <input
        id={id("reminders")}
        className={styles.input}
        value={reminders}
        placeholder="за час и за 15 минут · каждый час с 8 до 12"
        onChange={(event) => setReminders(event.target.value)}
      />
      <div className={styles.chips}>
        <button
          type="button"
          className={styles.primary}
          style={{ flex: 1 }}
          disabled={busy}
          onClick={() => void save()}
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
  );
}

function PlanTab({ summary, call, busy }: { summary: MiniAppSummary; call: Call; busy: boolean }) {
  return (
    <>
      <div className={styles.headerText}>
        <span className={styles.caption}>то же, что «JARVIS · План» в боте</span>
        <h1 className={styles.title}>Расписание</h1>
      </div>
      {summary.plan.length ? (
        summary.plan.map((section) => (
          <PlanSectionCard key={section.title} section={section} call={call} busy={busy} />
        ))
      ) : (
        <div className={styles.card}>
          <span className={styles.caption}>План пуст.</span>
        </div>
      )}
    </>
  );
}

type Call = (path: string, init?: RequestInit) => Promise<boolean>;

function FoodTab({ summary, busy, call }: { summary: MiniAppSummary; busy: boolean; call: Call }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [pending, setPending] = useState<{ blob: Blob; url: string } | null>(null);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [described, setDescribed] = useState<{ text: string; when: string } | null>(null);
  const { food, goals } = summary;
  const maxValue = Math.max(goals.calories * 1.25, ...food.week.map((day) => day.calories), 1);

  // Photo first, then "what is it and roughly how much", then the estimate.
  async function choose(file: File) {
    const blob = await compressImage(file);
    setPending({ blob, url: URL.createObjectURL(blob) });
  }

  function discard() {
    if (pending) URL.revokeObjectURL(pending.url);
    setPending(null);
    setCaption("");
  }

  async function analyze() {
    if (!pending) return;
    const form = new FormData();
    form.append("photo", pending.blob, "food.jpg");
    if (caption.trim()) form.append("caption", caption.trim());
    if (await call("/api/miniapp/food", { method: "POST", body: form })) discard();
  }

  // No photo: describe the meal in words and say when it was eaten.
  async function logDescribed() {
    if (!described?.text.trim()) return;
    const logged = await call("/api/miniapp/food", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: described.text.trim(), eatenAtLocal: described.when }),
    });
    if (logged) setDescribed(null);
  }

  return (
    <>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.caption}>
            цель {kcal(goals.calories)} ккал · Б {goals.proteinG} · Ж {goals.fatG} · У{" "}
            {goals.carbsG}
          </span>
          <h1 className={styles.title}>Питание</h1>
        </div>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => setGoalsOpen((open) => !open)}
        >
          Цели
        </button>
      </div>
      {goalsOpen ? (
        <GoalsCard summary={summary} busy={busy} call={call} close={() => setGoalsOpen(false)} />
      ) : null}

      <div className={styles.card}>
        {pending ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
            <img
              src={pending.url}
              alt="Фото еды"
              style={{ width: "100%", maxHeight: 260, objectFit: "cover", borderRadius: 14 }}
            />
            <label className={styles.caption} htmlFor="food-caption">
              Что это и сколько примерно
            </label>
            <textarea
              id="food-caption"
              className={styles.input}
              style={{ minHeight: 72, paddingTop: 10 }}
              value={caption}
              placeholder="например: шаурма с курицей без соуса, лаваша мало, ~300 г"
              onChange={(event) => setCaption(event.target.value)}
            />
            <div className={styles.chips}>
              <button
                type="button"
                className={styles.primary}
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => void analyze()}
              >
                {busy ? "Анализирую…" : "Анализировать"}
              </button>
              <button type="button" className={styles.secondary} disabled={busy} onClick={discard}>
                Отмена
              </button>
            </div>
          </>
        ) : null}
        <input
          ref={fileInput}
          className={styles.hidden}
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="Фото еды"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void choose(file);
          }}
        />
        <button
          type="button"
          className={styles.primary}
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {pending ? "Переснять" : "Сфотографировать еду"}
        </button>
        {described ? (
          <>
            <label className={styles.caption} htmlFor="food-text">
              Что съел и сколько
            </label>
            <textarea
              id="food-text"
              className={styles.input}
              style={{ minHeight: 72, paddingTop: 10 }}
              value={described.text}
              placeholder="например: овсянка на молоке ~250 г и банан"
              onChange={(event) => setDescribed({ ...described, text: event.target.value })}
            />
            <label className={styles.caption} htmlFor="food-when">
              Когда
            </label>
            <input
              id="food-when"
              className={styles.input}
              type="datetime-local"
              value={described.when}
              max={localNow()}
              onChange={(event) => setDescribed({ ...described, when: event.target.value })}
            />
            <div className={styles.chips}>
              <button
                type="button"
                className={styles.primary}
                style={{ flex: 1 }}
                disabled={busy || !described.text.trim()}
                onClick={() => void logDescribed()}
              >
                {busy ? "Считаю…" : "Посчитать"}
              </button>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => setDescribed(null)}
              >
                Отмена
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => setDescribed({ text: "", when: localNow() })}
          >
            Записать без фото
          </button>
        )}
      </div>

      {food.today.map((entry) => (
        <FoodCard key={`${entry.id}-${entry.calories}`} entry={entry} busy={busy} call={call} />
      ))}

      <section className={styles.card} aria-label="Неделя питания">
        <h2 className={styles.sectionTitle}>Неделя</h2>
        <div className={styles.chart}>
          <div
            className={styles.targetLine}
            style={{ bottom: `calc(${(goals.calories / maxValue) * 100}% * 0.82 + 22px)` }}
          />
          {food.week.map((day) => (
            <div key={day.date} className={styles.chartColumn}>
              <div
                className={styles.chartBar}
                style={{
                  height: `${(day.calories / maxValue) * 82}%`,
                  background: day.isToday
                    ? "var(--accent)"
                    : day.calories > goals.calories * 1.05
                      ? "var(--fat)"
                      : day.calories
                        ? "#6C7A92"
                        : "var(--line)",
                }}
              />
              <span className={styles.caption}>{day.label}</span>
            </div>
          ))}
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.caption}>В среднем</span>
            <span className={styles.statValue}>{kcal(food.averageCalories)} ккал</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.caption}>В норме ±5%</span>
            <span className={styles.statValue}>
              {food.daysInTarget} из {food.loggedDays}
            </span>
          </div>
        </div>
      </section>

      {food.photos.length ? (
        <section className={styles.card} aria-label="Фото еды за неделю">
          <h2 className={styles.sectionTitle}>Фото за неделю · {food.photos.length}</h2>
          <div className={styles.photoGrid}>
            {food.photos.map((photo) => (
              <figure key={photo.id} className={styles.photoTile}>
                {/* eslint-disable-next-line @next/next/no-img-element -- signed private photo */}
                <img src={photo.url} alt={photo.title} loading="lazy" />
                <figcaption>
                  {photo.label} · {photo.calories} ккал
                </figcaption>
                <button
                  type="button"
                  className={styles.photoRemove}
                  aria-label={`Удалить фото: ${photo.title}`}
                  disabled={busy}
                  onClick={() => void removePhoto(call, photo.id)}
                >
                  ✕
                </button>
              </figure>
            ))}
          </div>
          <span className={styles.caption}>
            Фото хранятся сжатыми. Удаление стирает только снимок — запись и калории остаются.
          </span>
        </section>
      ) : null}
    </>
  );
}

// Telegram's own dialog when available, the browser one otherwise.
function confirmAction(message: string) {
  return new Promise<boolean>((resolve) => {
    const app = window.Telegram?.WebApp;
    if (app?.showConfirm) app.showConfirm(message, resolve);
    else resolve(window.confirm(message));
  });
}

async function removePhoto(call: Call, id: string) {
  if (await confirmAction("Удалить фото? Запись и калории останутся.")) {
    await call(`/api/miniapp/food?id=${id}&what=photo`, { method: "DELETE" });
  }
}

function FoodCard({
  entry,
  busy,
  call,
}: {
  entry: MiniAppSummary["food"]["today"][number];
  busy: boolean;
  call: Call;
}) {
  const [grams, setGrams] = useState(entry.items.map((item) => item.grams));

  const changed = grams.some((value, index) => value !== entry.items[index]?.grams);
  const step = (index: number, delta: number) =>
    setGrams((current) =>
      current.map((value, i) => (i === index ? Math.max(0, (value ?? 0) + delta) : value)),
    );
  return (
    <section className={styles.card} aria-label={entry.title}>
      {entry.photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed private photo
        <img className={styles.foodPhoto} src={entry.photoUrl} alt={entry.title} loading="lazy" />
      ) : null}
      <div className={styles.header}>
        <span style={{ fontSize: 17, fontWeight: 600 }}>{entry.title}</span>
        <span className={styles.ringValue} style={{ fontSize: 18, color: "var(--accent)" }}>
          {entry.calories}
        </span>
      </div>
      <div className={styles.pills}>
        <span className={styles.pill} style={{ color: "var(--protein)" }}>
          Б {entry.proteinG}
        </span>
        <span className={styles.pill} style={{ color: "var(--fat)" }}>
          Ж {entry.fatG}
        </span>
        <span className={styles.pill} style={{ color: "var(--carbs)" }}>
          У {entry.carbsG}
        </span>
        <span className={styles.caption}>{entry.time}</span>
      </div>
      {entry.items.map((item, index) => (
        <div key={`${item.name}-${index}`} className={styles.ingredient}>
          <span className={styles.ingredientName}>{item.name}</span>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Меньше: ${item.name}`}
            onClick={() => step(index, -10)}
          >
            −
          </button>
          <span className={styles.grams}>{grams[index] ?? "—"} г</span>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Больше: ${item.name}`}
            onClick={() => step(index, 10)}
          >
            +
          </button>
        </div>
      ))}
      <div className={styles.chips}>
        {changed ? (
          <button
            type="button"
            className={styles.primary}
            style={{ flex: 1, minHeight: 44 }}
            disabled={busy}
            onClick={() =>
              void call("/api/miniapp/food", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: entry.id, grams }),
              })
            }
          >
            Сохранить
          </button>
        ) : null}
        {entry.photoUrl ? (
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => void removePhoto(call, entry.id)}
          >
            Удалить фото
          </button>
        ) : null}
        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={async () => {
            const question = entry.photoUrl ? "Удалить запись вместе с фото?" : "Удалить запись?";
            if (await confirmAction(question)) {
              await call(`/api/miniapp/food?id=${entry.id}`, { method: "DELETE" });
            }
          }}
        >
          {entry.photoUrl ? "Удалить запись" : "Удалить"}
        </button>
      </div>
    </section>
  );
}

function GoalsCard({
  summary,
  busy,
  call,
  close,
}: {
  summary: MiniAppSummary;
  busy: boolean;
  call: Call;
  close: () => void;
}) {
  const [goals, setGoals] = useState(summary.goals);
  const fromMacros = goals.proteinG * 4 + goals.fatG * 9 + goals.carbsG * 4;
  const field = (key: "calories" | "proteinG" | "fatG" | "carbsG", label: string) => (
    <div className={styles.field}>
      <label htmlFor={`goal-${key}`}>{label}</label>
      <input
        id={`goal-${key}`}
        className={styles.numberInput}
        type="number"
        inputMode="numeric"
        value={goals[key]}
        onChange={(event) => setGoals({ ...goals, [key]: Number(event.target.value) || 0 })}
      />
    </div>
  );
  return (
    <section className={styles.card} aria-label="Цели питания">
      <h2 className={styles.sectionTitle}>Цели питания</h2>
      {field("calories", "Калории в день")}
      {field("proteinG", "Белки, г")}
      {field("fatG", "Жиры, г")}
      {field("carbsG", "Углеводы, г")}
      <span className={styles.caption}>Из Б/Ж/У получается {kcal(fromMacros)} ккал</span>
      <span>Калории тренировок к норме</span>
      <div className={styles.chips} role="group" aria-label="Калории тренировок">
        {([0, 50, 100] as const).map((percent) => (
          <button
            key={percent}
            type="button"
            className={goals.workoutPercent === percent ? styles.chipActive : styles.chip}
            onClick={() => setGoals({ ...goals, workoutPercent: percent })}
          >
            {percent === 0 ? "Не добавлять" : `+${percent}%`}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={styles.primary}
        disabled={busy}
        onClick={async () => {
          if (
            await call("/api/miniapp/summary", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(goals),
            })
          )
            close();
        }}
      >
        Сохранить цели
      </button>
    </section>
  );
}

function FitnessTab({ summary }: { summary: MiniAppSummary }) {
  const { fitness } = summary;
  const wellness = fitness.latestWellness;
  const hours = Math.floor(fitness.movingTimeS / 3600);
  const minutes = Math.round((fitness.movingTimeS % 3600) / 60);
  return (
    <>
      <div className={styles.headerText}>
        <span className={styles.caption}>Garmin → Intervals.icu · эта неделя</span>
        <h1 className={styles.title}>Тренировки</h1>
      </div>
      <div className={styles.stats3}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{fitness.count}</span>
          <span className={styles.caption}>тренировок</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>
            {hours}:{String(minutes).padStart(2, "0")}
          </span>
          <span className={styles.caption}>часов</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{kcal(fitness.calories)}</span>
          <span className={styles.caption}>ккал</span>
        </div>
      </div>
      <section className={styles.card} aria-label="Восстановление">
        <h2 className={styles.sectionTitle}>Восстановление</h2>
        {wellness ? (
          <div className={styles.stats3}>
            <div className={styles.stat}>
              <span className={styles.caption}>Сон</span>
              <span className={styles.statValue}>
                {wellness.sleepSecs
                  ? `${Math.floor(wellness.sleepSecs / 3600)}:${String(Math.round((wellness.sleepSecs % 3600) / 60)).padStart(2, "0")}`
                  : "—"}
              </span>
            </div>
            <div className={styles.stat}>
              <span className={styles.caption}>HRV</span>
              <span className={styles.statValue}>{wellness.hrv ?? "—"}</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.caption}>Пульс покоя</span>
              <span className={styles.statValue}>{wellness.restingHr ?? "—"}</span>
            </div>
          </div>
        ) : null}
        <p className={styles.pre}>{fitness.wellnessText}</p>
      </section>
      <section className={styles.card} aria-label="Тренировки недели">
        <h2 className={styles.sectionTitle}>Последние тренировки</h2>
        {fitness.activities.length ? (
          <div className={styles.rows}>
            {fitness.activities.map((activity) => (
              <div key={activity.id} className={styles.row}>
                <span>
                  {activity.title} <span className={styles.caption}>· {activity.day}</span>
                </span>
                <span className={styles.detail}>{activity.metrics}</span>
                {activity.extra ? <span className={styles.detail}>{activity.extra}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <span className={styles.caption}>
            Тренировок пока нет. Загрузи историю Garmin в настройках Intervals.icu.
          </span>
        )}
      </section>
    </>
  );
}

// Device-local "now" in the datetime-local format (yyyy-MM-ddTHH:mm).
function localNow() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// Phone photos are several MB; a 1280px JPEG is plenty for the estimate and fits the upload limit.
async function compressImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob ?? file), "image/jpeg", 0.82),
    );
  } catch {
    return file;
  }
}
