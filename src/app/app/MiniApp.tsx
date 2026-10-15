"use client";

import Script from "next/script";
import { useCallback, useRef, useState } from "react";

import type { MiniAppSummary } from "@/services/miniappSummary";

import styles from "./miniapp.module.css";

type Tab = "today" | "plan" | "food" | "fitness";
type TelegramWebApp = {
  initData: string;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  addToHomeScreen?(): void;
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
};

export function MiniApp() {
  const [initData, setInitData] = useState<string | null>(null);
  const [summary, setSummary] = useState<MiniAppSummary | null>(null);
  const [tab, setTab] = useState<Tab>("today");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initDataRef = useRef("");

  const call = useCallback(async (path: string, init?: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        ...init,
        headers: { ...(init?.headers ?? {}), "x-telegram-init-data": initDataRef.current },
      });
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

  // Runs once the Telegram script is ready (also on remount); no effect-driven state.
  const connectTelegram = useCallback(() => {
    const app = window.Telegram?.WebApp;
    if (!app || initDataRef.current) return;
    app.ready();
    app.expand();
    app.setHeaderColor?.("#0F1218");
    app.setBackgroundColor?.("#0F1218");
    initDataRef.current = app.initData ?? "";
    setInitData(initDataRef.current);
    if (initDataRef.current) void call("/api/miniapp/summary");
  }, [call]);

  return (
    <div className={styles.app}>
      <Script src="https://telegram.org/js/telegram-web-app.js" onReady={connectTelegram} />
      <div className={styles.content}>
        {initData === "" ? <div className={styles.notice}>{ERRORS.unauthorized}</div> : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        {!summary && initData !== "" ? <div className={styles.caption}>Загружаю…</div> : null}
        {summary && tab === "today" ? (
          <TodayTab summary={summary} openPlan={() => setTab("plan")} />
        ) : null}
        {summary && tab === "plan" ? <PlanTab summary={summary} /> : null}
        {summary && tab === "food" ? <FoodTab summary={summary} busy={busy} call={call} /> : null}
        {summary && tab === "fitness" ? <FitnessTab summary={summary} /> : null}
      </div>
      <nav className={styles.tabbar} aria-label="Разделы">
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

function TodayTab({ summary, openPlan }: { summary: MiniAppSummary; openPlan: () => void }) {
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
        {app?.addToHomeScreen ? (
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
        near.map((section) => <PlanSectionCard key={section.title} section={section} />)
      ) : (
        <div className={styles.card}>
          <span className={styles.caption}>На сегодня в плане ничего нет.</span>
        </div>
      )}
    </>
  );
}

function PlanSectionCard({ section }: { section: MiniAppSummary["plan"][number] }) {
  return (
    <section className={styles.card} aria-label={section.title}>
      <h2 className={styles.sectionTitle}>{section.title}</h2>
      {section.rows.length ? (
        <div className={styles.rows}>
          {section.rows.map((row, index) => (
            <div key={`${row.text}-${index}`} className={styles.row}>
              <span>{row.text}</span>
              {row.details.map((detail) => (
                <span key={detail} className={styles.detail}>
                  {detail}
                </span>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      {section.note ? <span className={styles.caption}>{section.note}</span> : null}
    </section>
  );
}

function PlanTab({ summary }: { summary: MiniAppSummary }) {
  return (
    <>
      <div className={styles.headerText}>
        <span className={styles.caption}>то же, что «JARVIS · План» в боте</span>
        <h1 className={styles.title}>Расписание</h1>
      </div>
      {summary.plan.length ? (
        summary.plan.map((section) => <PlanSectionCard key={section.title} section={section} />)
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
  const [goalsOpen, setGoalsOpen] = useState(false);
  const { food, goals } = summary;
  const maxValue = Math.max(goals.calories * 1.25, ...food.week.map((day) => day.calories), 1);

  async function upload(file: File) {
    const form = new FormData();
    form.append("photo", await compressImage(file), "food.jpg");
    if (caption.trim()) form.append("caption", caption.trim());
    if (await call("/api/miniapp/food", { method: "POST", body: form })) setCaption("");
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
        <label className={styles.caption} htmlFor="food-caption">
          Подпись к фото (необязательно)
        </label>
        <input
          id="food-caption"
          className={styles.input}
          value={caption}
          placeholder="например: гречка с курицей, 300 г"
          onChange={(event) => setCaption(event.target.value)}
        />
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
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          className={styles.primary}
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? "Считаю калории…" : "Сфотографировать еду"}
        </button>
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
    </>
  );
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
        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={() => void call(`/api/miniapp/food?id=${entry.id}`, { method: "DELETE" })}
        >
          Удалить
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
