"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  anchorDraft,
  draftTotals,
  draftWeight,
  finishFoodDraft,
  newDraftItem,
  setDraftCalories,
  setDraftGrams,
  setDraftMacro,
  setDraftName,
  setDraftTotalWeight,
  startFoodDraft,
} from "@/domain/foodEdit";
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
  isVersionAtLeast?(version: string): boolean;
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
  done_needs_bot: "Это событие ещё впереди — отметь его в боте, там можно уточнить, что произошло.",
  invalid: "Проверь поля: у каждого продукта должно быть название.",
};

export function MiniApp() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [summary, setSummary] = useState<MiniAppSummary | null>(null);
  const [tab, setTab] = useState<Tab>("today");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
        message?: string;
        summary?: MiniAppSummary;
      };
      if (!response.ok || !body.ok || !body.summary) {
        throw new Error(ERRORS[body.error ?? ""] ?? "Что-то пошло не так. Попробуй ещё раз.");
      }
      setSummary(body.summary);
      // A short confirmation, so a tap never feels like it did nothing.
      if (body.message) {
        const message = body.message;
        setNotice(message);
        window.setTimeout(
          () => setNotice((current) => (current === message ? null : current)),
          5000,
        );
      }
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
        {notice ? (
          <div className={styles.notice} role="status">
            {notice}
          </div>
        ) : null}
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
        {summary && tab === "fitness" ? (
          <FitnessTab summary={summary} call={call} busy={busy} />
        ) : null}
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

type Sheet = "schedule" | "food" | "workout" | "settings";

const SHEET_TITLES: Record<Sheet, string> = {
  schedule: "Добавить в расписание",
  food: "Добавить еду",
  workout: "Добавить тренировку",
  settings: "Настройки",
};

const TODAY_SECTIONS = /^(Сейчас|Сегодня|Не закрыто|Просрочено|Требует|Прошло)/;
const UPCOMING_SECTIONS = /^(Завтра|Скоро|Позже)/;

// Home: calories, three quick "add" buttons, then today and what comes next.
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
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const { budget, eaten, goals, workoutCalories } = summary;
  const circumference = 2 * Math.PI * 84;
  const today = summary.plan.filter((section) => TODAY_SECTIONS.test(section.title));
  const upcoming = summary.plan
    .filter((section) => UPCOMING_SECTIONS.test(section.title))
    .flatMap((section) => section.rows)
    .slice(0, 6);
  const macros = [
    ["Белки", eaten.proteinG, goals.proteinG, "var(--protein)"],
    ["Жиры", eaten.fatG, goals.fatG, "var(--fat)"],
    ["Углеводы", eaten.carbsG, goals.carbsG, "var(--carbs)"],
  ] as const;
  const close = () => setSheet(null);
  return (
    <>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <span className={styles.caption}>{summary.dateLabel}</span>
          <h1 className={styles.title}>Сегодня</h1>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Настройки"
          onClick={() => setSheet("settings")}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d={GEAR_PATH} />
          </svg>
        </button>
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
      <div className={styles.quickActions}>
        {(
          [
            ["schedule", "В расписание", "M8 3v4M16 3v4M4 9h16M5 5h14v15H5zM12 12v6M9 15h6"],
            ["food", "Еда", "M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-2 6 0 8v10"],
            ["workout", "Тренировка", "M3 12h4l3-7 4 14 3-7h4"],
          ] as Array<[Sheet, string, string]>
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={styles.quickAction}
            onClick={() => setSheet(id)}
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
            <span>+ {label}</span>
          </button>
        ))}
      </div>
      <div className={styles.header}>
        <h2 className={styles.sectionTitle}>На сегодня</h2>
        <button type="button" className={styles.linkButton} onClick={openPlan}>
          Всё расписание
        </button>
      </div>
      {today.length ? (
        today.map((section) => (
          <PlanSectionCard key={section.title} section={section} call={call} busy={busy} />
        ))
      ) : (
        <div className={styles.card}>
          <span className={styles.caption}>На сегодня дел нет.</span>
        </div>
      )}
      {upcoming.length ? (
        <PlanSectionCard
          section={{ title: "Ближайшее", rows: upcoming, note: null }}
          call={call}
          busy={busy}
        />
      ) : null}
      {sheet ? (
        <SheetPanel title={SHEET_TITLES[sheet]} close={close}>
          {sheet === "schedule" ? (
            <ScheduleCreateForm call={call} busy={busy} done={close} />
          ) : null}
          {sheet === "food" ? <FoodAddCard call={call} busy={busy} onDone={close} /> : null}
          {sheet === "workout" ? <WorkoutForm call={call} busy={busy} done={close} /> : null}
          {sheet === "settings" ? (
            <SettingsPanel mode={mode} install={install} logout={logout} />
          ) : null}
        </SheetPanel>
      ) : null}
    </>
  );
}

const GEAR_PATH =
  "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z";

// A bottom sheet; tapping the dimmed area or ✕ closes it.
function SheetPanel({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.sheetLayer}>
      <button type="button" className={styles.sheetBackdrop} aria-label="Закрыть" onClick={close} />
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <h2 className={styles.sectionTitle}>{title}</h2>
          <button type="button" className={styles.iconButton} aria-label="Закрыть" onClick={close}>
            ✕
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

// Install the app, put the Telegram icon on the home screen, or sign this device out.
function SettingsPanel({
  mode,
  install,
  logout,
}: {
  mode: Mode | null;
  install: (() => void) | null;
  logout: () => void;
}) {
  const app = window.Telegram?.WebApp;
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  return (
    <>
      {mode === "telegram" && app?.addToHomeScreen ? (
        <button type="button" className={styles.secondary} onClick={() => app.addToHomeScreen?.()}>
          Иконка JARVIS на экран «Домой»
        </button>
      ) : null}
      {mode === "browser" && !standalone ? (
        install ? (
          <button type="button" className={styles.primary} onClick={install}>
            Установить JARVIS
          </button>
        ) : (
          <span className={styles.caption}>
            {ios
              ? "Установить: в Safari кнопка «Поделиться» → «На экран „Домой“»."
              : "Установить: в меню браузера «Установить приложение» или «Добавить на главный экран»."}
          </span>
        )
      ) : null}
      <span className={styles.caption}>
        Цели по калориям и БЖУ — на вкладке «Питание», кнопка «Цели».
      </span>
      {mode === "browser" ? (
        <button type="button" className={styles.secondary} onClick={logout}>
          Выйти на этом устройстве
        </button>
      ) : null}
    </>
  );
}

const TASK_REMINDERS = [
  ["at_time", "В это время"],
  ["1h", "За час"],
  ["1d", "За день"],
] as const;
const EVENT_REMINDERS = [
  ["at_time", "В начале"],
  ["15m", "За 15 мин"],
  ["1h", "За час"],
  ["2h", "За 2 часа"],
  ["1d", "За день"],
] as const;
const DURATIONS = [
  [30, "30 мин"],
  [60, "1 час"],
  [90, "1,5 часа"],
  [120, "2 часа"],
] as const;

// "Добавить в расписание" without Telegram: a task (with an optional deadline), a meeting
// or a planned training, with quick reminders and an optional one in the bot's words.
function ScheduleCreateForm({ call, busy, done }: { call: Call; busy: boolean; done: () => void }) {
  const [kind, setKind] = useState<"task" | "event" | "training">("task");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(localNow().slice(0, 10));
  const [time, setTime] = useState("");
  const [duration, setDuration] = useState(60);
  const [reminders, setReminders] = useState<string[]>(["at_time"]);
  const [extra, setExtra] = useState("");
  const isEvent = kind !== "task";
  const options = isEvent ? EVENT_REMINDERS : TASK_REMINDERS;
  const canRemind = Boolean(date && time);
  const missingTime = isEvent && !canRemind;

  function switchKind(next: typeof kind) {
    setKind(next);
    setReminders(next === "task" ? ["at_time"] : ["1h"]);
  }

  function toggle(value: string) {
    setReminders((current) =>
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
    );
  }

  async function save() {
    const saved = await call("/api/miniapp/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create",
        kind,
        title: title.trim(),
        dateLocal: date || null,
        timeLocal: time || null,
        durationMinutes: duration,
        reminders: canRemind ? reminders : [],
        remindersText: extra.trim() || null,
      }),
    });
    if (saved) done();
  }

  return (
    <>
      <div className={styles.chips}>
        {(
          [
            ["task", "Задача"],
            ["event", "Встреча"],
            ["training", "Тренировка"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={kind === value ? styles.chipActive : styles.chip}
            onClick={() => switchKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className={styles.caption} htmlFor="create-title">
        Что
      </label>
      <input
        id="create-title"
        className={styles.input}
        value={title}
        placeholder={isEvent ? "например: стоматолог с Робом" : "например: оплатить кружок"}
        onChange={(event) => setTitle(event.target.value)}
      />
      <span className={styles.caption}>{isEvent ? "Когда" : "Срок (можно без него)"}</span>
      <div className={styles.dateRow}>
        <input
          className={styles.input}
          type="date"
          aria-label="Дата"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <input
          className={styles.input}
          type="time"
          aria-label="Время"
          value={time}
          onChange={(event) => setTime(event.target.value)}
        />
      </div>
      {!isEvent && date ? (
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            setDate("");
            setTime("");
          }}
        >
          Без срока
        </button>
      ) : null}
      {isEvent ? (
        <div className={styles.chips}>
          {DURATIONS.map(([minutes, label]) => (
            <button
              key={minutes}
              type="button"
              className={duration === minutes ? styles.chipActive : styles.chip}
              onClick={() => setDuration(minutes)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <span className={styles.caption}>Напомнить</span>
      {canRemind ? (
        <div className={styles.chips}>
          {options.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={reminders.includes(value) ? styles.chipActive : styles.chip}
              onClick={() => toggle(value)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <span className={styles.detail}>Укажи дату и время — тогда можно выбрать напоминание.</span>
      )}
      <input
        className={styles.input}
        aria-label="Своё напоминание"
        value={extra}
        placeholder="или своё: «каждый час с 8 до 12»"
        onChange={(event) => setExtra(event.target.value)}
      />
      <button
        type="button"
        className={styles.primary}
        disabled={busy || !title.trim() || missingTime}
        onClick={() => void save()}
      >
        {busy ? "Добавляю…" : "Добавить"}
      </button>
    </>
  );
}

const WORKOUT_SPORTS = [
  ["WeightTraining", "Силовая"],
  ["Run", "Бег"],
  ["Ride", "Велосипед"],
  ["VirtualRide", "Велотренажёр"],
  ["Walk", "Ходьба"],
  ["Swim", "Плавание"],
  ["Yoga", "Йога"],
  ["Workout", "Другое"],
] as const;
const DISTANCE_SPORTS = new Set(["Run", "Ride", "Walk", "Swim"]);

// "Добавить тренировку": for sessions the watch did not record.
function WorkoutForm({ call, busy, done }: { call: Call; busy: boolean; done: () => void }) {
  const [sport, setSport] = useState<string>("WeightTraining");
  const [when, setWhen] = useState(localNow());
  const [duration, setDuration] = useState("45");
  const [calories, setCalories] = useState("");
  const [distance, setDistance] = useState("");
  const number = (value: string) => Number(value.replace(",", "."));
  const durationValue = number(duration);

  async function save() {
    const saved = await call("/api/miniapp/workout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sportType: sport,
        startLocal: when,
        durationMinutes: durationValue,
        calories: calories.trim() ? number(calories) : null,
        distanceKm: DISTANCE_SPORTS.has(sport) && distance.trim() ? number(distance) : null,
      }),
    });
    if (saved) done();
  }

  return (
    <>
      <div className={styles.chips}>
        {WORKOUT_SPORTS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={sport === value ? styles.chipActive : styles.chip}
            onClick={() => setSport(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className={styles.caption} htmlFor="workout-when">
        Когда
      </label>
      <input
        id="workout-when"
        className={styles.input}
        type="datetime-local"
        value={when}
        max={localNow()}
        onChange={(event) => setWhen(event.target.value)}
      />
      <div className={styles.dateRow}>
        <label className={styles.caption} htmlFor="workout-duration">
          Минут
          <input
            id="workout-duration"
            className={styles.input}
            inputMode="numeric"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
        </label>
        <label className={styles.caption} htmlFor="workout-calories">
          Калории
          <input
            id="workout-calories"
            className={styles.input}
            inputMode="numeric"
            value={calories}
            placeholder="посчитаю сам"
            onChange={(event) => setCalories(event.target.value)}
          />
        </label>
      </div>
      {DISTANCE_SPORTS.has(sport) ? (
        <label className={styles.caption} htmlFor="workout-distance">
          Дистанция, км (необязательно)
          <input
            id="workout-distance"
            className={styles.input}
            inputMode="decimal"
            value={distance}
            onChange={(event) => setDistance(event.target.value)}
          />
        </label>
      ) : null}
      <span className={styles.detail}>
        Для тренировок без часов. Записанные часами придут сами из Garmin.
      </span>
      <button
        type="button"
        className={styles.primary}
        disabled={busy || !(durationValue >= 1)}
        onClick={() => void save()}
      >
        {busy ? "Записываю…" : "Записать"}
      </button>
    </>
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
                  <span className={styles.rowActions}>
                    {canMarkDone(row.item) ? (
                      <button
                        type="button"
                        className={styles.linkButton}
                        disabled={busy}
                        onClick={() => void markDone(call, row.item!.id)}
                      >
                        Сделал
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setEditing(editing === row.number ? null : row.number)}
                    >
                      {editing === row.number ? "Закрыть" : "Изменить"}
                    </button>
                  </span>
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

// Events count as done once they have started; tasks any time.
function canMarkDone(item: EditableItem) {
  const isEvent = ["event", "training", "tentative_event"].includes(item.kind);
  return !isEvent || Boolean(item.startLocal && item.startLocal <= localNow());
}

async function markDone(call: Call, id: string) {
  await call("/api/miniapp/item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, action: "done" }),
  });
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
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const { food, goals } = summary;
  const maxValue = Math.max(goals.calories * 1.25, ...food.week.map((day) => day.calories), 1);

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

      <FoodAddCard busy={busy} call={call} />

      {food.today.map((entry) => (
        <FoodCard
          key={`${entry.id}-${entry.calories}-${entry.title}`}
          entry={entry}
          busy={busy}
          call={call}
          zoom={setZoomed}
        />
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
                <button
                  type="button"
                  className={styles.thumbButton}
                  aria-label={`Открыть фото: ${photo.title}`}
                  onClick={() => setZoomed(photo.url)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- signed private photo */}
                  <img src={photo.url} alt={photo.title} loading="lazy" />
                </button>
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

      {zoomed ? (
        <button
          type="button"
          className={styles.lightbox}
          aria-label="Закрыть фото"
          onClick={() => setZoomed(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed private photo */}
          <img src={zoomed} alt="" />
        </button>
      ) : null}
    </>
  );
}

// Photo or words. Lives on the Питание tab and in the home screen's "Еда" sheet.
function FoodAddCard({ busy, call, onDone }: { busy: boolean; call: Call; onDone?: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [caption, setCaption] = useState("");
  const [pending, setPending] = useState<{ blob: Blob; url: string } | null>(null);
  const [described, setDescribed] = useState<{ text: string; when: string } | null>(null);

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
    if (await call("/api/miniapp/food", { method: "POST", body: form })) {
      discard();
      onDone?.();
    }
  }

  // No photo: describe the meal in words and say when it was eaten.
  async function logDescribed() {
    if (!described?.text.trim()) return;
    const logged = await call("/api/miniapp/food", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: described.text.trim(), eatenAtLocal: described.when }),
    });
    if (logged) {
      setDescribed(null);
      onDone?.();
    }
  }

  return (
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
  );
}

// Telegram's own dialog only inside Telegram 6.2+. Outside Telegram its script still
// defines showConfirm but throws, which silently swallowed every "Удалить" tap.
function confirmAction(message: string) {
  return new Promise<boolean>((resolve) => {
    const app = window.Telegram?.WebApp;
    if (app?.initData && app.showConfirm && app.isVersionAtLeast?.("6.2")) {
      try {
        app.showConfirm(message, resolve);
        return;
      } catch {
        // fall through to the browser dialog
      }
    }
    resolve(window.confirm(message));
  });
}

async function removePhoto(call: Call, id: string) {
  if (await confirmAction("Удалить фото? Запись и калории останутся.")) {
    await call(`/api/miniapp/food?id=${id}&what=photo`, { method: "DELETE" });
  }
}

type FoodEntryView = MiniAppSummary["food"]["today"][number];

function FoodCard({
  entry,
  busy,
  call,
  zoom,
}: {
  entry: FoodEntryView;
  busy: boolean;
  call: Call;
  zoom: (url: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <FoodEditor entry={entry} busy={busy} call={call} close={() => setEditing(false)} />;
  }
  return (
    <section className={styles.card} aria-label={entry.title}>
      <div className={styles.foodHead}>
        {entry.photoUrl ? (
          <button
            type="button"
            className={styles.thumbButton}
            aria-label="Открыть фото"
            onClick={() => zoom(entry.photoUrl!)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- signed private photo */}
            <img className={styles.thumb} src={entry.photoUrl} alt={entry.title} loading="lazy" />
          </button>
        ) : null}
        <div className={styles.foodHeadText}>
          <span style={{ fontSize: 17, fontWeight: 600 }}>{entry.title}</span>
          <span className={styles.caption}>{entry.time}</span>
        </div>
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
      </div>
      {entry.items.map((item, index) => (
        <div key={`${item.name}-${index}`} className={styles.ingredient}>
          <span className={styles.ingredientName}>{item.name}</span>
          <span className={styles.caption}>
            {item.grams ? `${item.grams} г · ` : ""}
            {item.calories} ккал
          </span>
        </div>
      ))}
      <div className={styles.chips}>
        <button
          type="button"
          className={styles.primary}
          style={{ flex: 1, minHeight: 44 }}
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          Изменить
        </button>
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

// Everything is editable; the calculator in domain/foodEdit keeps К, Б, Ж, У and the
// weights consistent while you type.
function FoodEditor({
  entry,
  busy,
  call,
  close,
}: {
  entry: FoodEntryView;
  busy: boolean;
  call: Call;
  close: () => void;
}) {
  const [title, setTitle] = useState(entry.title);
  const [when, setWhen] = useState(entry.eatenAtLocal);
  const [items, setItems] = useState(() => startFoodDraft(entry.items));
  const totals = draftTotals(items);
  const weight = draftWeight(items);
  const anchor = () => setItems((current) => anchorDraft(current));
  const update = (
    index: number,
    change: (item: (typeof items)[number]) => (typeof items)[number],
  ) => setItems((current) => current.map((item, i) => (i === index ? change(item) : item)));
  const id = (field: string) => `${entry.id}-${field}`;

  async function save() {
    const finished = finishFoodDraft(items);
    if (!finished.length) return;
    const saved = await call("/api/miniapp/food", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: entry.id,
        title: title.trim() || entry.title,
        eatenAtLocal: when,
        items: finished,
      }),
    });
    if (saved) close();
  }

  return (
    <section className={styles.card} aria-label={`Изменить: ${entry.title}`}>
      <label className={styles.caption} htmlFor={id("title")}>
        Название
      </label>
      <input
        id={id("title")}
        className={styles.input}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label className={styles.caption} htmlFor={id("when")}>
        Когда
      </label>
      <input
        id={id("when")}
        className={styles.input}
        type="datetime-local"
        value={when}
        max={localNow()}
        onChange={(event) => setWhen(event.target.value)}
      />
      <div className={styles.field}>
        <span style={{ whiteSpace: "nowrap" }}>Вес блюда, г</span>
        <NumberField
          id={id("weight")}
          label=""
          value={weight || null}
          onChange={(value) => setItems((current) => setDraftTotalWeight(current, value ?? 0))}
          onBlur={anchor}
        />
      </div>
      {items.map((item, index) => (
        <div key={index} className={styles.editItem}>
          <div className={styles.ingredient}>
            <input
              className={styles.input}
              value={item.name}
              placeholder="Продукт"
              aria-label="Продукт"
              onChange={(event) => update(index, (row) => setDraftName(row, event.target.value))}
            />
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`Убрать: ${item.name || "продукт"}`}
              onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
          <div className={styles.macroInputs}>
            <NumberField
              id={id(`${index}-g`)}
              label="г"
              value={item.grams}
              onChange={(value) => update(index, (row) => setDraftGrams(row, value))}
              onBlur={anchor}
            />
            <NumberField
              id={id(`${index}-p`)}
              label="Б"
              color="var(--protein)"
              value={item.proteinG}
              onChange={(value) =>
                update(index, (row) => setDraftMacro(row, "proteinG", value ?? 0))
              }
            />
            <NumberField
              id={id(`${index}-f`)}
              label="Ж"
              color="var(--fat)"
              value={item.fatG}
              onChange={(value) => update(index, (row) => setDraftMacro(row, "fatG", value ?? 0))}
            />
            <NumberField
              id={id(`${index}-c`)}
              label="У"
              color="var(--carbs)"
              value={item.carbsG}
              onChange={(value) => update(index, (row) => setDraftMacro(row, "carbsG", value ?? 0))}
            />
            <NumberField
              id={id(`${index}-k`)}
              label="ккал"
              color="var(--accent)"
              value={item.calories}
              onChange={(value) => update(index, (row) => setDraftCalories(row, value ?? 0))}
              onBlur={anchor}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        className={styles.secondary}
        onClick={() => setItems((current) => [...current, newDraftItem()])}
      >
        + Продукт
      </button>
      <div className={styles.editTotals}>
        <span>Итого</span>
        <span>
          <b style={{ color: "var(--accent)" }}>{totals.calories} ккал</b> · Б {totals.proteinG} · Ж{" "}
          {totals.fatG} · У {totals.carbsG}
        </span>
      </div>
      <span className={styles.caption}>
        Калории считаются сами: белки и углеводы по 4 ккал на грамм, жиры — 9. Вес меняет всё
        пропорционально.
      </span>
      <div className={styles.chips}>
        <button
          type="button"
          className={styles.primary}
          style={{ flex: 1, minHeight: 44 }}
          disabled={busy || !finishFoodDraft(items).length}
          onClick={() => void save()}
        >
          Сохранить
        </button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={close}>
          Отмена
        </button>
      </div>
    </section>
  );
}

// Shows what you type while focused (so "1" → "12" → "120" works), the calculated value
// otherwise.
function NumberField({
  id,
  label,
  value,
  color,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  value: number | null;
  color?: string;
  onChange: (value: number | null) => void;
  onBlur?: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className={styles.macroField} htmlFor={id}>
      {label ? <span style={color ? { color } : undefined}>{label}</span> : null}
      <input
        id={id}
        className={styles.macroInput}
        inputMode="decimal"
        value={text ?? (value === null ? "" : String(value))}
        onFocus={(event) => {
          setText(value === null ? "" : String(value));
          event.target.select();
        }}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (!raw.trim()) return onChange(null);
          const parsed = Number(raw.replace(",", "."));
          if (Number.isFinite(parsed) && parsed >= 0) onChange(parsed);
        }}
        onBlur={() => {
          setText(null);
          onBlur?.();
        }}
      />
    </label>
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

function FitnessTab({
  summary,
  call,
  busy,
}: {
  summary: MiniAppSummary;
  call: Call;
  busy: boolean;
}) {
  const [adding, setAdding] = useState(false);
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
      {adding ? (
        <section className={styles.card} aria-label="Добавить тренировку">
          <WorkoutForm call={call} busy={busy} done={() => setAdding(false)} />
        </section>
      ) : (
        <button type="button" className={styles.secondary} onClick={() => setAdding(true)}>
          + Добавить тренировку вручную
        </button>
      )}
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
                {activity.manual ? (
                  <button
                    type="button"
                    className={styles.linkButton}
                    style={{ alignSelf: "flex-start" }}
                    disabled={busy}
                    onClick={async () => {
                      if (await confirmAction("Удалить эту тренировку?")) {
                        await call(`/api/miniapp/workout?id=${activity.id}`, { method: "DELETE" });
                      }
                    }}
                  >
                    Удалить (добавлена вручную)
                  </button>
                ) : null}
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
