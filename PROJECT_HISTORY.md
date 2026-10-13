# История проекта ZNAMBO Telegram Assistant

## V2.16.0 reminder session routing and calendar feedback hardening

V2.16.0 fixes the reminder setup routing regression where a reply like `В 7.00 и 7.30`
inside the multi-reminder flow could be parsed as an item schedule edit.

Implemented:

```text
multi_reminder_setup_session now runs before item_edit_session and only creates reminders
reminder setup prompts are deduped through policy_editor message cleanup
same-message event+relative reminders create attached before_event policies
reminder-only follow-up messages attach to a recent future event
committed summaries count policy-created reminders and list reminder labels
calendar sync feedback is appended after local mutation confirmation
ended event-like items move to history before today/important classification
daily history filters fake standalone reminder rows
/admin_repair_v2160 preview|apply covers local safe cleanup and stale sessions
```

Validation:

```text
npm test -- src/tests/v2160ReminderRouting.test.ts -> 6 passed
npx tsc --noEmit -> passed
```

## V2.15.0 release notification and deploy completion

V2.15.0 adds a persistent, idempotent production release-completion notification without
rewriting Jarvis, mandatory OpenAI planning, ActionPlan execution, Yandex CalDAV, reminder
policies, or cron-job.org scheduling.

Implemented:

```text
assistant.release_notifications stores version+commit+environment delivery state
duplicate notification calls return already_sent and do not send a second Telegram message
failed Telegram delivery is stored as failed and can be retried
same-version hotfix notifications require an explicit allowHotfix flag
release gate verifies production health, exact version, exact commit, webhook, runner,
migration evidence, smoke evidence, and handoff completion
/version and /release show concise live production status
/release_notes and /changelog show safe structured release notes
/release_notify is owner-only through the existing Telegram allowlist middleware
protected admin action release_notify uses the existing CRON_SECRET bearer guard
/api/health exposes only safe latest release-notification metadata
drizzle/0009_release_notifications.sql adds the persistent idempotency store
```

Validation before deploy:

```text
npm test -> 58 files passed, 296 tests passed
npm run lint -> passed
npm run build -> passed
targeted V2.15 tests -> 13 passed
git diff --check -> passed
production migration -> applied and verified
production deployment -> appVersion 2.15.0, commit abb71c88c4dc80657a2b1cbb2f5ea327433a7c4e
webhook -> correct URL, pending updates 0
runner -> configured, successful and fresh
automatic reminder smoke -> delivered at 2026-06-15T20:19:09.419Z
release notification -> sent at 2026-06-15T20:20:30.517Z, Telegram message id 868
duplicate-call proof -> already_sent, no second Telegram message
```

## V2.14.0 corrective completion after full brief re-audit

The original V2.14 rollout covered the core reminder draft, duplicate detection, multi-policy
creation, completed view, cleanup confirmation, overdue classification and repair. A second
line-by-line audit of the source brief found product-level gaps and completed them without changing
the app version or database schema.

Corrective implementation:

```text
neutral multi-reminder edits now ask add versus replace when event reminders already exist
explicit add and replace language is respected; replace cancels old policies and future reminders
item cards list reminders individually and expose remove-one/remove-all controls
cleanup now lists messages, old completed items, stale drafts and broken reminders with counts
every cleanup category uses a stored preview session and explicit confirmation
completed archive now removes the row from /completed; restore never blindly restarts old reminders
unknown before-event offsets are shown as needs-clarification and repair pauses them for review
failed decision traces receive non-empty reason, field and suggested prompt
agent action transitions and actionlog output cannot expose committed and cancelled markers together
V2.14 repair now detects and normalizes contradictory recurring draft action rows
```

Validation:

```text
npm test -> 57 files passed, 283 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
database migration -> not required
```

## V2.14.0 reminder UX, multi-reminders, completed items and audit hardening

V2.14.0 was implemented on top of V2.13.0 without replacing Jarvis, mandatory OpenAI planning,
ActionPlan execution, Yandex CalDAV, the production reminder runner, or cron-job.org scheduling.
No database migration was required.

Implemented:

```text
weekly recurring reminders without time now become typed clarification drafts, not saved failures
similar recurring policies trigger update/create-new/cancel duplicate resolution
reminder setup menu was rewritten around concrete user intents
one event can now receive several before-event reminders from one reply
before-event policies render concrete offsets such as za den v 09:00, za 2 chasa, za 30 minut
/completed and /done show completed items with pagination, restore and archive actions
/cleanup and /cleanup_chat now show a preview and never delete planner data or Yandex Calendar objects
normal active past tasks are shown as overdue; unresolved is reserved for broken/review data
missing recurring-time audit/debug fields now include reason, field and suggested prompt
/admin_repair_v2140 preview|apply added; repair changes zero Yandex Calendar objects
protected admin API actions v2140_repair_preview and v2140_repair_apply added
```

Validation before deploy:

```text
npm test -> 57 files passed, 274 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
secret scan -> no live secrets added; README env placeholders only
```

Production rollout:

```text
target application version -> 2.14.0
production URL -> https://znambo-telegram-assistant.vercel.app
GitHub/Vercel auto-deploy -> pending after repository push
/api/health, Telegram webhook and reminder smoke -> pending post-deploy verification
```

## V2.13.0 command targeting, draft integrity and actionlog production rollout

V2.13.0 was implemented and deployed on top of V2.12.0 without replacing the mandatory OpenAI
planner, ActionPlan execution, reminder runner, Yandex CalDAV integration, or existing calendar
import. No database migration was required.

Implemented:

```text
recurring missing-time policies are blocked before action_plans/items/policies/reminders are saved
recurring_policy_draft sessions now store fingerprints and dedupe repeated incomplete requests
global creation-intent escape preserves recurring drafts for dedupe while cancel still clears them
legacy executeActionPlanForMessage now uses the same recurring missing-time draft guard
item edit/reschedule supports "сегодня целый день" / "today all day" as explicit all-day schedule
snooze callbacks write assistant.reminder_snooze_attempt audit and fall back to item snooze
undo normalizes scheduled event-like task snapshots back to event
/actionlog, /actionlog 24h, /actionlog 50, /actionlog export and /debugrecent added
/admin_repair_v2130 preview|apply added; repair changes zero Yandex Calendar objects
```

Validation:

```text
npm test -> 56 files passed, 266 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
secret scan -> no live secrets added; README env placeholders only
```

Production rollout:

```text
application version -> 2.13.0
production commit -> 5a558afd5a0065ecb815f2fc9ab6c66e7e7f7d4a
production URL -> https://znambo-telegram-assistant.vercel.app
/api/health -> appVersion and deployment commit matched
Telegram webhook -> correct production URL, pending updates 0, no last error
OpenAI health -> real call succeeded, structured output valid, response ID present
V2.13 repair preview/apply -> incomplete meter items 0, policies 0, duplicate drafts 0, stale sessions 0, calendar objects changed 0
recurring missing-time probe -> AI called, recurring_task proposed, rule monthly_days:15,16,17,18,19, no execution
reminder smoke -> delivered to Telegram, deliveryStatus sent at 2026-06-15T09:51:07.483Z, test item auto-archived
cron-job.org runner -> configured and lastRunnerSucceeded true after smoke
```

Remaining limitations:

```text
The protected multi-action probe proposed the main Zoom event plus Z2 training, but the current
admin snapshot does not expose per-action reminders and did not split the tentative short-video
call into a separate object. Treat that as the next smart-planner behavior gap.
Yandex Calendar remains best-effort and must not block planner/reminder writes.
```

## Update 2026-06-13 - V2.8.0 Production Rollout

V2.8.0 was deployed through GitHub/Vercel auto-deploy and verified against production.

Production rollout:

```text
validated application commit -> d2ccd86f5cc4b74144b0938513e78f4bcf23757d
GitHub CI -> passed
/api/health -> ok, appVersion 2.8.0, matching deployment commit
Telegram webhook -> correct production URL, pending 0, no last error
cron-job.org runner -> completed successfully
active policies -> 1
policies missing next reminder -> 0
Yandex import error -> none
```

Database rollout:

```text
drizzle/0008_reminder_policy_snooze.sql applied to production Neon
planner_items.snoozed_until verified
reminder_policies.snoozed_until verified
reminder_policies.snooze_scope verified
```

Production acceptance found and fixed two release edges:

- The first snooze-aware claim query used a nullable outer join with `FOR UPDATE SKIP LOCKED`,
  which PostgreSQL cannot lock. It now uses `NOT EXISTS`.
- The complex three-reminder phrase used plural `показания счётчиков`; the post-AI normalizer now
  recognizes it, with an integration test through the real OpenAI proposal path.

Final proof:

```text
V2.8 repair preview -> 0 cadence-only garbage tasks, 0 garbage policies, 0 stale sessions
complex production agent probe -> AI called, AI succeeded, structured output valid, 3 actions
agent probe -> read-only, no user records created
automatic two-minute reminder smoke -> sent to Telegram and auto-archived
npm test -> 51 files, 203 tests passed
npm run lint -> passed
npx tsc --noEmit -> passed
npm run build -> passed
git diff --check -> passed
```

No secrets were written to project history.

## V2.12.0 recurring UX cleanup, marker controls, monthly drafts and production repair

V2.12.0 was implemented on top of V2.11.0 without replacing the mandatory OpenAI planner,
ActionPlan execution, reminder runner, Yandex CalDAV integration, or snooze system. No database
migration was required.

Implemented:

```text
weekly missing-time recurring reminders stay typed drafts until explicit time selection
commit and policy-execution guards reject canonical recurring rules without time
Russian AM/PM windows parse: 8 утра-8 вечера, восьми утра-восьми вечера, 10 утра-6 вечера
recurring item cadence edits update the weekly recurring policy instead of creating a one-day window
runner supports recurring interval windows, including weekly hourly 08:00-20:00 until done
monthly 15-19 day-range reminders draft cleanly when time is missing
Plan/reminder rendering removes duplicate ❗ and omits "без времени" for unscheduled recurring rows
item card marker controls: Auto / Show / Hide
filler recurring titles normalize to human task titles
/admin_repair_v2120 preview|apply repairs mirror/Fedotov production state without Yandex changes
```

Validation:

```text
npm test -> 55 files passed, 262 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
secret scan -> no live secrets added
```

Production rollout:

```text
application version -> 2.12.0
production commit -> 411aaea1f6872c566b128169a9d984b684f4f558
production URL -> https://znambo-telegram-assistant.vercel.app
/api/health -> appVersion and deployment commit matched
Telegram webhook -> correct URL, pending updates 0, no last error
OpenAI health -> real call succeeded, structured output valid
V2.12 repair before apply -> mirror item 1, malformed mirror policies 2, Fedotov broken policies 1, safe yes
V2.12 repair apply -> renamed 1 item, normalized 1 target policy, superseded 1 duplicate, moved 1 Fedotov policy to review, calendar objects changed 0
V2.12 repair after apply -> malformed 0, Fedotov 0, stale sessions 0
dashboard snapshot -> no "без времени", no "🔔 ❗", no Fedotov, no 02:59, no 300 мин
monthly 15-19 agent probe -> AI called and succeeded, rule monthly_days:15,16,17,18,19, no start/due
reminder runner smoke -> protected POST /api/reminders/run sent 1 due reminder; health shows scheduler configured and last runner succeeded
```

Remaining limitations:

```text
The exact Telegram monthly draft conversation and marker button clicks were covered by automated
tests/probes, not manually driven in the owner chat during this rollout.
The smoke reminder was completed by an explicit protected runner call; cron-job.org remains
configured as production scheduler and health reported lastRunnerSucceeded true.
Yandex Calendar remains best-effort and must not block planner/reminder writes.
```

## V2.11.0 reminder setup state machine and session escape fix

V2.11.0 was implemented on top of V2.10.0 without replacing the mandatory OpenAI planner,
ActionPlan execution, recurrence engine, reminder runner, or Yandex CalDAV integration.

The release adds a shared session router for natural-language turns. Cancel phrases now clear
active item edit, reminder setup, recurring draft, and external calendar edit sessions. New global
weekly/monthly reminder creation requests escape stale item sessions and proceed through the AI
planner instead of being parsed as an edit to the previous task.

Reminder setup now persists collected fields across turns and understands local end-of-day
boundaries in setup context. `do kontsa dnya`, `do kontsa segodnyashnego dnya`, and `do 23.59`
complete the active reminder window as `23:59`; full cadence phrases can apply in one turn.

The safe `/admin_repair_v2110 preview|apply` repair restores only the known World Cup recap task
deadline to `2026-06-14 23:59 Europe/Moscow`, keeps the intended 30-minute policy, detaches no
unrelated policies in the observed production state, clears stale sessions when present, and changes
zero Yandex Calendar objects.

Pre-deployment validation:

```text
npm test -> 54 files, 247 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
database migration -> not required
```

Production acceptance:

```text
active production commit -> 7598f93e8877722c625f1a0fbc957a2d4e48ff53
/api/health -> appVersion 2.11.0, matching deployment commit
Telegram webhook -> ok, pending 0, no last error
OpenAI health -> real call succeeded, response ID present
V2.11 repair preview -> 1 target, wrong dueAt detected, safe yes
V2.11 repair apply -> updated 1 item, normalized 1 policy, calendar objects changed 0
planner snapshot -> World Cup recap dueAt 2026-06-14T20:59:00.000Z
dashboard snapshot -> no wrong 15.06 08:00 World Cup recap block
UTF-8 monthly probe -> monthly_days:15,16,17,18,19
UTF-8 weekly timed probe -> weekly:MO@10:00, requireAck true
automatic reminder smoke -> sent through cron-job.org and test item auto-cancelled
```

No secrets were written to project history.

Production rollout completed:

```text
active production commit -> 6abad3f886dabfbcc1e2bb15ace86fbb0d12caeb
/api/health -> appVersion 2.10.0 and matching deployment commit
OpenAI health -> real call succeeded, structured output valid
weekly missing-time probe -> recurring_task, weekly:MO, requireAck true
weekly timed probe -> recurring_task, weekly:MO@10:00, requireAck true
monthly range probe -> recurring_task, monthly_days:15,16,17,18,19
multi-reminder probe -> two recurring_task actions and two policies
end-of-day probe -> local due time 2026-06-14 23:59 Europe/Moscow
Telegram webhook -> pending 0, no last error
repair before apply -> 1 garbage task, 1 garbage policy, safe yes
repair apply -> archived 1 task and 1 policy, 0 calendar objects changed
repair after apply -> 0 candidates
automatic reminder smoke -> sent and auto-archived
cron-job.org runner -> succeeded, policiesMissingNextReminder 0
```

The owner still needs to manually walk through one Telegram recurring draft and select its time.
No secrets were written to history.

## Update 2026-06-12 - V2.6.0 Plan UI and Yandex Inbound Calendar

Implemented in the release working tree:

```text
clean Plan rows without red/green/yellow urgency circles
separate current-event section and editable none/star/fire/auto importance
compact item-card menu with technical actions under More
in-place callback card updates where Telegram permits editing
persistent Telegram bottom navigation
time-range parsing with preserved endAt
same-day bare-hour PM disambiguation
rename without quotes and full old/new compound-edit preview
CalDAV REPORT inbound import, ICS parsing and weekly recurrence expansion
external Yandex event cache merged into Plan without creating local planner items
external event cards, local hide and CalDAV delete-everywhere actions
/calendar_sync and /calendar_import_status
bounded 15-minute background import that cannot block reminders
```

Production database rollout:

```text
drizzle/0007_yandex_inbound_calendar.sql applied idempotently
assistant.external_calendar_events exists
assistant.calendar_import_state exists
external calendar unique/start/UID indexes exist
```

Production acceptance:

```text
validated application commit -> 8506145e6f281cd12c69941664e4bf69a38c9810
/api/health -> ok, appVersion 2.6.0, Jarvis pipeline active
Yandex import -> 38 visible external events, 32 recurring occurrences, no import error
Plan snapshot -> 23 items, 1 policy, no red urgency circles
Telegram webhook -> pending 0, no last error
real OpenAI health -> succeeded with valid structured output and tool call
post-fix reminder smoke -> claimed 1, sent 1, failed 0, delivered and auto-archived
```

During production acceptance, external-event callback data exceeded Telegram's 64-byte limit and
caused `BUTTON_DATA_INVALID` during compact reminder delivery. V2.6.0 now uses the short wire alias
`external`; a regression test enforces the callback-data limit. Non-recurring external events can
also be edited/rescheduled at the same CalDAV object URL.

Local validation:

```text
npm test -> 48 files, 176 tests passed
npm run lint -> passed
npx tsc --noEmit -> passed
npm run build -> passed
git diff --check -> passed
```

## V2.8.0 reminder policy UX, snooze and Plan routing

V2.8.0 makes reminder policies feel like part of their tasks instead of exposing policy-engine
internals. `/plan` and `/dashboard` now render Plan directly, policies are shown inline with a
persistent `❗` marker, and user-facing dates include weekdays.

Reminder-edit context now binds cadence-only replies to the selected item. Global cadence-only text
asks what to remind about instead of creating a garbage task. The known complex three-reminder
production phrase produces a safe three-intent preview with targeted clarification.

Real policy/item snooze was added through `snoozed_until` fields. Claims, reconciliation,
materialization and a final runner pre-delivery check all respect the mute, preventing intermediate
or already-claimed reminders from leaking during snooze. A conservative `/admin_repair_v280`
preview/apply path archives only the known cadence-only garbage task when exactly one safe target
exists and never deletes Yandex Calendar events.

Production rollout and acceptance completed. See the V2.8.0 production rollout entry above.

Pre-deployment validation completed:

```text
drizzle/0008_reminder_policy_snooze.sql applied to production Neon
planner_items.snoozed_until verified
reminder_policies.snoozed_until verified
reminder_policies.snooze_scope verified
npm test -> 51 files, 203 tests passed
npm run lint -> passed
npx tsc --noEmit -> passed
npm run build -> passed
git diff --check -> passed
```

## V2.7.0 reminder capture and calendar import hygiene

V2.7.0 fixes the production regressions discovered after inbound Yandex Calendar import.

Implemented:

- Clear reminders are normalized only after mandatory OpenAI planning, including exact clock,
  relative one-time, and open-ended hourly nag-until-ack requests.
- The validation guard accepts open-ended nag policies and names the exact missing field when it
  must block.
- External calendar import classifies service/test and past events. The default Plan hides them,
  while visibility and cleanup commands can change the local JARVIS view without deleting Yandex
  data.
- Timeline buckets, conflict detection, Plan wording, and reminder-policy rendering were aligned.
- Voice transcription, natural-language planner attempts, and guard blocks gained safe audit and
  health diagnostics.
- Added safe `/calendar_cleanup`, `/calendar_view`, and `/admin_repair_v270` commands.

No schema migration is required because the release uses existing metadata fields.

Pre-deployment validation:

```text
npm test -> 49 files, 187 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
```

Production rollout:

```text
application commit -> 0038d8fb516fdf3ef347fd96af2e7a16bda7fe06
GitHub validate -> passed
Vercel production deployment -> passed
/api/health -> appVersion 2.7.0 and matching deployment commit
webhook route -> reachable
cron-job.org runner -> timestamp advanced during observation, last run succeeded
reminder policies missing next reminder -> 0
Yandex import error -> none
```

Owner Telegram acceptance remains for the cleanup/repair previews, exact reminder behavior, and
voice transcription. No protected command was faked and no secret was exposed.

No secrets were written to project history.

## Update 2026-06-12 - V2.5.4.1 Item Card Edit Sessions

- Fixed the production bug where a reply to an opened item card edit was intercepted by the global
  `reschedule_by_indices` guard and asked for a list number.
- Added active item edit sessions stored in `assistant.agent_actions` without a new migration.
- `manage:edit` and `manage:reschedule` now bind the next natural-language reply to the selected
  planner item.
- Added compound item mutation support for title rename, date/time move, event-like kind inference,
  `nag_until_ack` hourly reminders, preview confirmation, calendar best-effort sync, dashboard
  refresh, conflict hints, and Undo.
- Fixed Russian date parsing for `на понедельник 8 утра`, `в понедельник в 8`,
  `во вторник к 10.20`, `15.06 на 8 утра`, and past same-day confirmation.
- Slash commands clear stale edit sessions so `/dashboard`, `/plan`, and other commands render
  their requested view instead of continuing an old card edit.
- The live dashboard now moves active same-day past items out of upcoming `Сегодня` and into the
  unresolved section.
- Local validation: 47 test files and 166 tests passed; lint and build passed.
- No secrets were written to project history.

Production rollout:

```text
production URL -> https://znambo-telegram-assistant.vercel.app
validated runtime commit -> bd76bb2c4189f01051b6a63940c5b61af6b490b0
health -> ok, appVersion 2.5.4.1, Jarvis pipeline active
webhook -> correct production URL, pending 0, no last error
automatic scheduler -> lastRunnerRunAt advanced after deployment, runner succeeded
dashboard snapshot -> ok, 4 items, 0 policies
manual Telegram item-card edit smoke -> not run to avoid mutating live tasks without explicit user action
```

## Update 2026-06-12 - V2.5.4 Unified Plan UX

- Replaced the today-only dashboard with one canonical Plan showing today, tomorrow, soon,
  conflicts, important, long-term, and unresolved work.
- Added `/plan`, consistent numeric item cards, clearer Tasks and reminder-rule navigation, and
  optional post-create triage.
- Added event overlap detection after create/update and on the main Plan.
- Replaced immediate numbered deletion with a current-view preview and explicit confirmation.
- Fixed the critical parser bug where `5,6,7,8` plus `10.00-11.00` could target items 1-8.
- Added repeat-policy delete scope choice, undo/refresh flow, and conservative V2.5.4 repair.
- Added protected read-only snapshots for repair preview and reminder-center production acceptance.
- Added a protected server-side Telegram webhook status probe that never returns the bot token.
- CalDAV, scheduler, runner lock, reminder engine, and OpenAI ActionPlan architecture were
  preserved.
- Local validation before rollout: 46 test files and 158 tests passed; lint and build passed.
- No secrets were written to project history.

Production rollout:

```text
validated runtime commit -> 8fd00ad51014977fb0e7ac346b1b08e7519d33ef
health -> ok, appVersion 2.5.4, Jarvis pipeline active
webhook -> correct production URL, pending 0, no last error
automatic scheduler -> lastRunnerRunAt advanced, lastRunnerSucceeded true
dashboard snapshot -> 4 items, two tomorrow rows, upcoming orthodontist, visible conflict
planner snapshot -> the same 4 items
reminder center -> empty rule state explains /plan and /tasks instead of a dead end
V2.5.4 repair preview -> retained 4, restore 0, archive 0
repair apply -> not required and not run
```

## Update 2026-06-12 - V2.5.3.1

- Fixed normal Yandex CalDAV sync so it uses deterministic object URLs and matching ICS UIDs.
- Added abortable immediate sync, idempotent retry queue, retry-first GET, commands, card controls,
  safe diagnostics, production repair, and Russian dashboard pluralization.
- Applied `drizzle/0006_calendar_sync_resilience.sql` to production Neon.
- Production acceptance confirmed `/calendar_test`, orthodontist repair, and automatic retry
  through the existing minute runner.
- Validation: 44 test files and 149 tests passed; lint, TypeScript, and build passed.
- No secrets were written to project history.

Обновлено: 2026-06-09, Europe/Moscow.

Этот файл фиксирует историю создания и текущего состояния проекта без значений секретов. Все токены, пароли, ключи API и строки подключения намеренно не записаны.

## 1. Исходная задача

Проект был запрошен как рабочий MVP по файлу `CODEX_TASK_PERSONAL_TELEGRAM_ASSISTANT.md`.

Цель: приватный Telegram-ассистент для одного владельца, который принимает текст, голос и медиа, извлекает из сообщений задачи, встречи, напоминания, заметки и подготовку, показывает карточку подтверждения, сохраняет данные только после подтверждения, умеет напоминать и синхронизировать события с календарем.

Дополнительные требования по ходу работы:

- Подготовить проект в GitHub.
- Развернуть проект на Vercel.
- Подключить Neon Postgres.
- Настроить Telegram webhook.
- Настроить OpenAI-интеграцию.
- Поддержать календарь.
- Вместо Google Calendar использовать Yandex Calendar, если возможно.
- Создать тесты и README.
- Не останавливаться на плане, а довести до рабочего MVP.

## 2. Репозитории и окружения

GitHub:

- `https://github.com/znamteam-max/ZNAMBO-Telegram-Assistant`
- Основная ветка: `main`
- Локальная рабочая папка: `C:\Users\znambo\Documents\Личное`

Vercel:

- Team/scope: `znambos-projects`
- Project: `znambo-telegram-assistant`
- Production URL: `https://znambo-telegram-assistant.vercel.app`
- GitHub repository подключен к Vercel project.

Последний известный production deployment:

- Deployment id: `dpl_HPcyedsVstcmVAwoahrcSwTKuB1d`
- Production alias: `https://znambo-telegram-assistant.vercel.app`

## 3. Основная архитектура MVP

Приложение собрано как Next.js App Router API-проект для Vercel.

Основные части:

- Telegram webhook: `src/app/api/telegram/webhook/route.ts`
- Reminder runner: `src/app/api/reminders/run/route.ts`
- Health endpoint: `src/app/api/health/route.ts`
- Export endpoint: `src/app/api/export/route.ts`
- Google OAuth endpoints оставлены как опциональная интеграция.
- Telegram bot на `grammy`.
- OpenAI SDK для анализа сообщений и транскрибации.
- Drizzle ORM + Postgres.
- Yandex Calendar через CalDAV.
- Cloudflare Worker для минутного cron напоминаний.
- Vitest tests.
- GitHub Actions CI.

Высокоуровневый поток:

```text
Telegram
  -> /api/telegram/webhook
  -> grammY middleware
  -> allowlist owner check
  -> idempotency by Telegram update_id
  -> command/message/callback handlers
  -> OpenAI parsing/transcription
  -> pending action confirmation
  -> Postgres records
  -> optional calendar sync

Reminder cron
  -> /api/reminders/run
  -> claim due reminders
  -> Telegram notification
```

## 4. Что было реализовано

### Telegram bot

Реализованы команды:

- `/start`
- `/help`
- `/today`
- `/tomorrow`
- `/week`
- `/tasks`
- `/settings`
- `/calendar`
- `/export`
- `/forget`

Реализован allowlist владельца через `ALLOWED_TELEGRAM_USER_IDS`.

Реализован confirmation-before-write:

- бот сначала предлагает карточку действия;
- запись создается только после inline-кнопки подтверждения;
- повторный клик защищен от дублей.

Поддержаны текстовые сообщения и медиа:

- text;
- voice;
- audio;
- video note;
- короткие video/mp4 в рамках лимитов Telegram/OpenAI.

### OpenAI

Реализовано:

- структурное извлечение задач, встреч, напоминаний, памяти и неоднозначных запросов;
- fallback-ответы;
- транскрибация аудио/видео;
- модели вынесены в env:
  - `OPENAI_TEXT_MODEL`;
  - `OPENAI_TRANSCRIPTION_MODEL`.

### База данных

Используется Postgres через Drizzle.

Бизнес-таблицы размещены в отдельной схеме `assistant`, чтобы не конфликтовать с существующими таблицами в `public`.

Созданные таблицы:

- `assistant.users`
- `assistant.telegram_messages`
- `assistant.message_attachments`
- `assistant.pending_actions`
- `assistant.planner_items`
- `assistant.reminders`
- `assistant.memories`
- `assistant.google_calendar_connections`
- `assistant.item_sync_state`
- `assistant.audit_log`

Важная деталь: в предоставленной Neon DB уже были таблицы в `public`, включая `public.users`. Поэтому схема была изолирована в `assistant`, а существующие `public.*` таблицы не трогались.

Миграция была применена вручную statement-by-statement, потому что `drizzle-kit migrate` на Neon pooler соединении зависал/падал. Сама схема применена успешно. Возможная техническая оговорка: запись в Drizzle migration journal могла не сохраниться из-за `ECONNRESET` на metadata insert/select. Приложение не запускает миграции на runtime, поэтому production работе это не мешает.

### Calendar

Сначала была реализована Google Calendar-интеграция через OAuth как опциональная.

Затем по запросу пользователя добавлен Yandex Calendar через CalDAV:

- `CALENDAR_PROVIDER=yandex`
- `YANDEX_CALDAV_URL`
- `YANDEX_CALDAV_USERNAME`
- `YANDEX_CALDAV_APP_PASSWORD`
- `YANDEX_CALDAV_CALENDAR_URL` опционально
- `YANDEX_CALENDAR_URL` для пользовательской ссылки в Telegram

Health endpoint показывает:

- `calendarProvider: "yandex"`
- `yandexCalendarConfigured: true`
- `googleCalendarConfigured: false`

Текущий известный статус Yandex Calendar: bot работает, но свежие runtime logs показывали `Yandex CalDAV PROPFIND failed: 401`. Это означает, что CalDAV авторизация не проходит. На ответы бота это не должно влиять; влияет только на синхронизацию событий в Яндекс.Календарь.

### Напоминания

Реализован endpoint:

- `POST /api/reminders/run`

Он защищен `Authorization: Bearer <CRON_SECRET>`, атомарно забирает due reminders и отправляет Telegram notification.

Для минутных напоминаний подготовлен Cloudflare Worker:

- `cloudflare-reminder-worker/`

Причина: Vercel team сейчас на тарифе Hobby, а минутный Vercel Cron доступен только на Pro. Поэтому для точных минутных напоминаний нужен Cloudflare Worker или апгрейд Vercel до Pro.

### Vercel

Настроены Production и Development env vars в Vercel.

Preview env vars не были автоматически скопированы, потому что Vercel хранит Production/Preview secrets как write-only и не возвращает значения через `vercel env pull`.

Production deploy работает.

### Telegram webhook

Webhook установлен на:

```text
https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
```

Используется Telegram secret token header:

```text
x-telegram-bot-api-secret-token
```

## 5. Инциденты и исправления

### Проблема 1: конфликт таблиц в Neon

Симптом:

- миграция в `public` конфликтовала с существующими таблицами.

Решение:

- бизнес-таблицы перенесены в schema `assistant`;
- добавлено `CREATE SCHEMA IF NOT EXISTS "assistant";`;
- существующие `public.*` таблицы не изменялись.

Коммит:

- `69251fd Isolate assistant tables in Postgres schema`

### Проблема 2: SSL для Neon

Симптом:

- соединение с Neon требовало SSL.

Решение:

- DB client и Drizzle config обновлены для `ssl: "require"` при `sslmode=require`.

Коммит:

- `b9c1e80 Require SSL for Neon Postgres connections`

### Проблема 3: Telegram bot не реагировал

Симптом:

- пользователь написал, что бот не реагирует;
- `getWebhookInfo` показывал `pending_update_count` и `500 Internal Server Error`;
- Vercel runtime logs показали:

```text
Bot not initialized! Either call `await bot.init()`, or directly set the `botInfo` option in the `Bot` constructor to specify a known bot info object.
```

Причина:

- grammY bot в serverless runtime не был инициализирован перед `handleUpdate`.

Решение:

- добавлен `getInitializedBot()` с кешированием `bot.init()`;
- webhook route теперь вызывает initialized bot перед `handleUpdate`.

После деплоя:

- Telegram доставил накопленные updates;
- `pending_update_count` стал `0`;
- свежий webhook request вернул `200`;
- новых `Telegram webhook failed` / `Bot update failed` не было.

Коммит:

- `bd5f62c Initialize Telegram bot before handling webhook`

## 6. Проверки

Локально проходили:

```bash
npm test
npm run lint
npm run build
```

Последнее известное состояние:

- 9 test files passed;
- 11 tests passed;
- lint passed;
- production build passed;
- Vercel production build passed.

Health endpoint:

```text
https://znambo-telegram-assistant.vercel.app/api/health
```

Возвращал:

```json
{
  "ok": true,
  "appUrl": "https://znambo-telegram-assistant.vercel.app",
  "defaultTimezone": "Europe/Moscow",
  "calendarProvider": "yandex",
  "googleCalendarConfigured": false,
  "yandexCalendarConfigured": true
}
```

## 7. Git history

```text
bd5f62c  2026-05-27T16:06:10+03:00  Initialize Telegram bot before handling webhook
acbb7bd  2026-05-27T15:16:29+03:00  Expose Yandex calendar health status
d6d39b0  2026-05-27T14:59:39+03:00  Polish calendar commands for Yandex provider
69251fd  2026-05-27T14:39:51+03:00  Isolate assistant tables in Postgres schema
b9c1e80  2026-05-27T14:14:04+03:00  Require SSL for Neon Postgres connections
fef5965  2026-05-27T14:06:48+03:00  Add Yandex Calendar CalDAV sync
bed0844  2026-05-27T09:11:23+03:00  Add GitHub CI for deployment readiness
ca649a1  2026-05-27T09:10:11+03:00  Build personal Telegram assistant MVP
```

## 8. Переменные окружения

Ниже только имена переменных. Значения секретов в этот файл не включены.

Основные:

- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_WEBHOOK_SECRET`
- `ALLOWED_TELEGRAM_USER_IDS`
- `OPENAI_API_KEY`
- `OPENAI_TEXT_MODEL`
- `OPENAI_TRANSCRIPTION_MODEL`
- `CRON_SECRET`
- `APP_ENCRYPTION_KEY`
- `NEXT_PUBLIC_APP_URL`
- `DEFAULT_TIMEZONE`

Yandex Calendar:

- `CALENDAR_PROVIDER`
- `YANDEX_CALDAV_URL`
- `YANDEX_CALDAV_USERNAME`
- `YANDEX_CALDAV_APP_PASSWORD`
- `YANDEX_CALDAV_CALENDAR_URL`
- `YANDEX_CALENDAR_URL`

Google Calendar, если понадобится:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_CALENDAR_ID`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`

## 9. Текущее состояние проекта

Работает:

- production app на Vercel;
- Telegram webhook;
- обработка Telegram updates после фикса grammY init;
- health endpoint;
- Postgres schema `assistant`;
- OpenAI parsing/transcription code path;
- confirmation-before-write flow;
- reminders data model and runner endpoint;
- Yandex Calendar provider selection.

Требует внешнего действия или проверки:

- Проверить бота руками в Telegram через `/start` и тестовое сообщение.
- Исправить Yandex CalDAV `401`, если нужна синхронизация в календарь.
- Подключить Cloudflare Worker для минутных напоминаний или перейти на Vercel Pro и включить Vercel Cron.
- При необходимости добавить Preview env vars вручную в Vercel dashboard.

## 10. Рекомендованный следующий порядок действий

1. Отправить боту `/start`.
2. Отправить тест: `завтра в 10:00 напомни позвонить`.
3. Нажать кнопку подтверждения в карточке.
4. Проверить, что запись появилась в `/tomorrow` или `/tasks`.
5. Если нужна календарная синхронизация, проверить Yandex app password и CalDAV endpoint.
6. Подключить Cloudflare Worker для minute cron.
7. После этого протестировать реальное напоминание на ближайшие 2-3 минуты.

## 11. Обновление 2026-06-01: V2 Smart AI Planner

Пользователь передал новый файл задачи:

- `CODEX_TASK_ZNAMBO_ASSISTANT_V2_SMART_AI_PLANNER (1).md`

Цель V2: перестроить проект из одношагового механического парсера в smart AI planner.

Реализовано в рабочем дереве:

- Добавлен multi-action `ActionPlan` вместо единственного `pending_action`.
- Добавлены схемы и миграция для:
  - `action_plans`;
  - `action_plan_items`;
  - `conversation_messages`;
  - `memory_facts`;
  - `conversation_summaries`;
  - `reminder_deliveries`;
  - `calendar_sync_jobs`;
  - новых полей recurring / repeat-until-ack в `reminders`;
  - `smart_commit_mode` в `users`.
- Добавлен smart planner:
  - `src/ai/planner.ts`;
  - `src/ai/heuristicActionPlanner.ts`;
  - `src/ai/plan-validator.ts`;
  - `src/ai/prompts/planner.system.ts`.
- Перед каждым ответом добавлен retrieval context:
  - memory facts;
  - conversation summaries;
  - recent messages;
  - active tasks;
  - items for the next 7 days.
- Telegram message flow переключен на:
  - save incoming conversation;
  - transcribe if needed;
  - build active context;
  - build `ActionPlan`;
  - smart commit or confirmation;
  - one multi-action summary instead of several duplicate cards.
- Добавлены recurring reminders и repeat-until-ack:
  - кнопки ack/snooze/skip/stop;
  - повтор, если нет подтверждения;
  - запись доставок в `reminder_deliveries`.
- Добавлена команда:
  - `/remindertest 2`
- Calendar sync оставлен best-effort:
  - DB и Telegram reminders являются source of truth;
  - calendar failure не блокирует сохранение;
  - шумные сообщения про ошибку календаря убраны из нового V2 flow.
- Обновлены:
  - `.env.example`;
  - `README.md`;
  - tests setup.

Добавлены acceptance tests по реальным кейсам из V2-файла:

- today basketball call;
- long Zoom + setup + tentative call + training;
- recurring reels reminder;
- NBA night event at `03:30`, not `15:30`;
- daily vitamins until ack.

Проверки после реализации:

```text
npm test      -> 10 files passed, 16 tests passed
npm run lint  -> passed
npm run build -> passed
```

Осталось применить перед production-проверкой:

- применить миграцию `drizzle/0001_smart_planner_v2.sql` к production DB;
- задеплоить обновленный код;
- проверить `/remindertest 2` в Telegram;
- убедиться, что Cloudflare Worker или другой cron реально вызывает `/api/reminders/run` каждую минуту.

## 12. Правило ведения истории

С 2026-06-01 пользователь попросил: после каждого сообщения вести файл с историей и изменениями.

Принято правило:

- после каждого значимого изменения проекта обновлять `PROJECT_HISTORY.md`;
- не записывать секреты, токены, пароли, ключи API и строки подключения;
- фиксировать, что изменено, какие проверки пройдены, что осталось сделать;
- если изменений в коде нет, фиксировать только важные решения или инструкции пользователя.

## 13. Rollout 2026-06-01: старт production-доводки V2

Пользователь попросил продолжить по актуальному `PROJECT_HISTORY.md` и довести уже реализованный V2 до production.

План rollout без переписывания V2:

1. Применить `drizzle/0001_smart_planner_v2.sql` к production Neon DB.
2. Проверить новые таблицы и поля в schema `assistant`.
3. Закоммитить и запушить V2-код.
4. Задеплоить Vercel production.
5. Проверить `/api/health`.
6. Проверить Telegram webhook после деплоя.
7. Проверить `/remindertest 2` или эквивалентную доставку реального reminder через runner.
8. Проверить, есть ли активный minute cron; если нет, дать точные Cloudflare команды.

Статус на момент старта:

- рабочее дерево содержит V2-изменения;
- `PROJECT_HISTORY.md` пока не был закоммичен;
- секреты в историю не записываются.

### 13.1. Production DB migration

Миграция `drizzle/0001_smart_planner_v2.sql` применена к production Neon DB.

Проверка schema `assistant` после применения:

- всего таблиц в `assistant`: 17;
- новые таблицы присутствуют:
  - `action_plans`;
  - `action_plan_items`;
  - `conversation_messages`;
  - `conversation_summaries`;
  - `memory_facts`;
  - `reminder_deliveries`;
  - `calendar_sync_jobs`;
- новые поля в `users`:
  - `smart_commit_mode`;
- новые поля в `reminders`:
  - `repeat_until_ack`;
  - `acked_at`;
  - `parent_reminder_id`;
  - `recurrence_key`.

PostgreSQL выдал только NOTICE о сокращении длинного имени foreign key constraint. Ошибок миграции не было.

### 13.2. Pre-deploy checks

После применения production DB migration повторно прогнаны проверки на текущем V2-коде:

```text
npm test      -> 10 files passed, 16 tests passed
npm run lint  -> passed
npm run build -> passed
```

### 13.3. GitHub push and Vercel deploy blocker

V2 rollout закоммичен и отправлен в GitHub:

```text
2ac48aa Roll out smart planner V2
```

`main` синхронизирован с `origin/main`.

Блокер прямого Vercel deploy из CLI:

- локальный `.vercel/project.json` указывает на production project `znambo-telegram-assistant`;
- текущая авторизация Vercel CLI больше не видит прежний scope `znambos-projects`;
- `npx vercel --prod --yes --scope znambos-projects` вернул ошибку `scope does not exist`;
- `npx vercel whoami` вернул `Not authorized`;
- `npx vercel teams ls` показал доступ только к `bolshes-projects`;
- вызов deploy без scope не смог прочитать settings linked project.

Health production URL при этом отвечает:

```text
https://znambo-telegram-assistant.vercel.app/api/health -> ok
```

Для завершения rollout нужен доступ Vercel CLI к team/project, где живет `znambo-telegram-assistant`, или подтверждение, что GitHub auto-deploy в этом проекте сработал после push `2ac48aa`.

### 13.4. Vercel auth wait

Rollout resumed from `PROJECT_HISTORY.md`. Production DB migration is already applied and V2 code is pushed to GitHub commit `2ac48aa`.

Current blocker remains Vercel authorization: `vercel login` is still waiting for device-flow confirmation, so direct production deploy and deployment inspection cannot proceed yet. No secrets were written to this history file.

### 13.5. Fresh Vercel auth request

The stale Vercel login session was cancelled and a fresh `vercel login` device-flow session was started.

Current auth URL:

```text
https://vercel.com/oauth/device?user_code=SPBW-ZXPB
```

Direct production deploy is paused until this device-flow authorization is approved for the Vercel account/team that owns `znambo-telegram-assistant`.

### 13.6. Health and cron code inspection

Production health endpoint currently responds successfully:

```text
GET https://znambo-telegram-assistant.vercel.app/api/health -> ok
calendarProvider -> yandex
yandexCalendarConfigured -> true
```

This proves the production URL is alive, but not yet that commit `2ac48aa` is the active deployment because the health payload does not expose a commit/version field.

Reminder cron code is present in `cloudflare-reminder-worker`:

- `wrangler.toml.example` contains `crons = ["* * * * *"]`;
- worker calls `POST /api/reminders/run`;
- worker authenticates with `Authorization: Bearer <CRON_SECRET>`.

Real Cloudflare Worker deployment and real scheduled invocations are not yet confirmed.

### 13.7. Telegram webhook check

Telegram Bot API `getWebhookInfo` was checked against the configured bot.

Safe result fields:

```text
url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
pending_update_count -> 0
last_error_message -> null
allowed_updates -> message, callback_query
```

The webhook is pointed at the production Vercel endpoint and Telegram reports no current delivery error.

This check should be repeated after the final confirmed Vercel production deployment.

### 13.8. Cloudflare cron status

Wrangler is authenticated locally for `znamteam@gmail.com`.

Cloudflare API check for worker `personal-assistant-reminder-worker` returned:

```text
Worker does not exist on your account.
```

So the minute cron is not currently connected under the expected worker name. The repository contains a worker template, but no real `wrangler.toml` file yet.

### 13.9. Cloudflare worker deploy config

Added `cloudflare-reminder-worker/wrangler.toml` without secrets:

```text
name -> personal-assistant-reminder-worker
main -> src/index.ts
cron -> * * * * *
```

`npx wrangler deploy --dry-run` succeeds:

```text
Total Upload: 0.94 KiB / gzip: 0.51 KiB
No bindings found.
```

The worker can now be deployed, but real cron delivery still requires setting `APP_REMINDER_RUN_URL` and `CRON_SECRET` and confirming that Vercel production uses the same `CRON_SECRET`.

### 13.10. Reminder runner production SQL fix

During rollout verification, the reminder runner path was inspected and a production bug was found:

```text
claimDueReminders used raw SQL table name `reminders`
```

Production tables are in schema `assistant`, so the raw SQL was fixed to use:

```text
"assistant"."reminders"
```

Verification after the fix:

```text
npm test -> 10 files passed, 16 tests passed
npm run lint -> passed
npm run build -> passed
```

### 13.11. Health deployment commit marker

Direct Vercel CLI deploy remains blocked by the linked `.vercel` project belonging to an inaccessible Vercel scope. To make GitHub auto-deploy verifiable from the public production URL, `/api/health` now includes a safe `deploymentCommit` field from `VERCEL_GIT_COMMIT_SHA`.

### 13.12. Production deployment confirmed

Commit `5c776ae` was pushed to GitHub:

```text
5c776ae Finalize production rollout plumbing
```

Production Vercel auto-deploy completed successfully. Public health now returns:

```text
ok -> true
deploymentCommit -> 5c776ae5801e2a7d7b51b0f4248c4c6c5b90bf9a
appUrl -> https://znambo-telegram-assistant.vercel.app
defaultTimezone -> Europe/Moscow
calendarProvider -> yandex
yandexCalendarConfigured -> true
```

Telegram webhook was checked again after deploy:

```text
url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
pending_update_count -> 0
last_error_message -> null
allowed_updates -> message, callback_query
```

### 13.13. Reminder cron blocker

Production `POST /api/reminders/run` returns `401 unauthorized` without a bearer token. This confirms that the endpoint is deployed and protected by `CRON_SECRET`.

Cloudflare Worker is still not deployed:

```text
personal-assistant-reminder-worker -> does not exist on Cloudflare account
```

Current blocker: the existing Vercel production project is in an inaccessible Vercel scope, so the current `CRON_SECRET` value cannot be read or changed from CLI. To connect Cloudflare cron safely, Cloudflare must receive the exact same `CRON_SECRET` value as Vercel production, or Vercel access must be granted to the project scope so the secret can be rotated in both places.

### 13.14. Latest production commit after history push

The final history-only commit was pushed and Vercel auto-deployed it as well:

```text
56299a5 Record production deploy verification
```

Production health now returns:

```text
deploymentCommit -> 56299a57713c267afca706101a6aa2dd491f7611
ok -> true
```

Telegram webhook after this deploy still reports:

```text
pending_update_count -> 0
last_error_message -> null
```

### 13.15. Cron secret and runner verification

The provided `CRON_SECRET` was tested against production `POST /api/reminders/run`.

Result:

```text
without bearer -> 401 unauthorized
with provided bearer -> not 401, but runner returned 500
```

The `500` was reproduced locally against production DB. Root cause:

```text
postgres-js raw SQL parameter binding rejected Date objects in claimDueReminders
```

Fix applied:

```text
claimDueReminders now passes now.toISOString() and casts it as timestamptz
```

Local runner verification after the fix:

```text
claimed -> 2
sent -> 2
failed -> 0
```

This proves the reminder delivery path can send Telegram messages once the fixed code is deployed.

### 13.16. Cloudflare worker created, cron limit blocker

The fixed runner was pushed as commit:

```text
55b62f6 Fix reminder cron timestamp binding
```

Vercel production health confirmed:

```text
deploymentCommit -> 55b62f6ef85e9c85c054eca5c1a40de8c7f05eb4
```

Production runner check with the provided bearer secret:

```text
POST /api/reminders/run -> ok: true, claimed: 0, sent: 0, failed: 0
```

Cloudflare worker status:

```text
worker -> personal-assistant-reminder-worker
url -> https://personal-assistant-reminder-worker.rngn.workers.dev
manual fetch -> ok: true, claimed: 0, sent: 0, failed: 0
secrets -> APP_REMINDER_RUN_URL, CRON_SECRET
schedules -> none
```

Cloudflare scheduled trigger could not be attached because the account already has the plan limit of 5 cron triggers.

Existing Cloudflare cron triggers:

```text
anfisa-training-stats      -> */15 * * * *
hoh-nhl-daily-results      -> */5 * * * *
mlb-daily-results          -> * * * * *
nba-players-proxy          -> */15 * * * *
tennis-daily-results       -> */15 * * * *
```

To finish automatic minute reminders, one existing Cloudflare cron trigger must be removed or the Cloudflare plan/limit must be increased. The new worker itself is ready and verified manually.

### 13.17. cron-job.org production scheduler

Cloudflare cron is no longer a production blocker.

Current production scheduler:

```text
provider -> cron-job.org
method -> POST
url -> https://znambo-telegram-assistant.vercel.app/api/reminders/run
test run -> 200 OK
```

Telegram delivery was confirmed through the real bot command:

```text
/remindertest 2 -> created a real reminder
real Telegram reminder -> delivered after about 2 minutes
```

Conclusion:

- automatic reminder delivery is confirmed in production;
- `/api/reminders/run` delivers real Telegram reminders;
- cron-job.org is the active production scheduler;
- Cloudflare Worker remains configured as a backup option, but it no longer blocks production rollout.

### 13.18. Smart planner production behavior fixes

The V2 Telegram flow was reviewed against the required production behavior scenarios.

Code fixes applied:

```text
history/retrieval -> memory retrieval now falls back to latest active facts when exact keyword search finds nothing
memory learning -> memory-only messages such as "Запомни: ..." are stored as memory facts without creating pending actions
action planner -> NBA/night sports rules can be saved as correction memory candidates
action planner -> "ночь на пятницу" resolves to Friday 03:30 local time, not 15:30
multi-action -> Zoom/preparation/tentative call/training scenario keeps separate actions instead of collapsing into one meeting
recurring reminders -> repeat-until-ack reminders continue chaining until acknowledgement or local cutoff
overview commands -> list queries now use typed Drizzle predicates for reliable date filtering
reminder keyboard -> repeat-until-ack reminders expose completion, snooze, skip, and stop actions
```

Validation completed locally and rerun before production deploy:

```text
npm test -> passed, 21 tests
npm run lint -> passed
npm run build -> passed
```

New tests cover:

```text
multi-action extraction from one real message
recurring reminder buttons and repeat-until-ack behavior
night sports event at 03:30 Moscow in "ночь на пятницу"
memory-only correction rule creation
repeat-until-ack runner chaining
```

### 13.19. Production smart planner verification

The smart planner fixes were committed and pushed to GitHub:

```text
commit -> 767f6cb3a63a9d98a0346a8ab1ae285bd739c663
message -> Verify smart planner production behavior
branch -> main
```

Vercel production auto-deploy completed. Health endpoint confirmed:

```text
url -> https://znambo-telegram-assistant.vercel.app/api/health
ok -> true
deploymentCommit -> 767f6cb3a63a9d98a0346a8ab1ae285bd739c663
calendarProvider -> yandex
yandexCalendarConfigured -> true
```

Telegram webhook check after deploy:

```text
webhook url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
pending_update_count -> 0
last_error_message -> null
allowed_updates -> message, callback_query
```

Protected reminder runner check after deploy:

```text
POST /api/reminders/run -> ok: true
claimed -> 0
sent -> 0
failed -> 0
```

Fresh `/remindertest 2` verification:

```text
created reminder -> 8523e175-3a05-4332-9ea0-c77c4d03c763
scheduledAt -> 2026-06-01T14:33:14.685Z
sentAt -> 2026-06-01T14:34:04.350Z
deliveryStatus -> sent
deliveredAt -> 2026-06-01T14:34:04.537Z
telegramMessageId -> 39
```

This confirms cron-job.org is calling the production runner and real Telegram delivery still works after the smart planner deploy.

Real multi-action Telegram-flow scenario A was run against production DB through the bot handler. Result:

```text
actionPlan -> 9613ee65-7e74-4174-ab1d-58e53daeec85
status -> committed
summary -> Разложил сообщение на запись, подготовку, tentative-созвон и тренировку.
confidence -> 92
items -> 4
```

Created action plan items:

```text
0 preparation      -> Начать настройку Zoom, due 2026-06-01T18:30:00, reminders 1
1 event            -> Запись Больше Zoom, start 2026-06-01T19:00:00, reminders 3
2 tentative_event  -> Возможный созвон по коротким видео, start 2026-06-01T19:30:00, reminders 1
3 training         -> Велосипед Z2, start 2026-06-01T20:00:00, reminders 2
```

Conclusion for scenario A:

- one V2 ActionPlan was created;
- actions were not collapsed into one meeting;
- preparation, event, tentative call, and training were stored separately;
- duplicate card behavior was not observed.

Overview command behavior was checked after creating the multi-action scenario:

```text
/today -> handler accepted; schedule query returned preparation, event, tentative_event, training, and reminder-test tasks
/tomorrow -> handler accepted; no items for the next day at verification time
/week -> handler accepted; weekly query returned the same structured items
/tasks -> handler accepted; open tasks included preparation and the recurring reels reminder
```

Production scheduler status:

```text
active scheduler -> cron-job.org
Cloudflare Worker -> backup only
production blocker -> none
```

Operational notes:

- the production webhook requires Telegram secret-token header, so synthetic webhook POSTs were not used;
- production behavior was verified through Bot API webhook metadata, the deployed health endpoint, the protected runner endpoint, production DB state, and bot handler checks using the same deployed commit;
- one malformed synthetic local update caused by PowerShell pipe encoding was cancelled immediately and was not used for verification;
- calendar sync remains best-effort by design, so DB commit and Telegram reminders are not blocked by calendar sync failures.

### 13.20. Intent-first assistant hardening started

New production-hardening task accepted.

Goal:

```text
make the bot behave as an adaptive daily assistant, not as a mechanical parser that creates items from every phrase
```

Scope for this pass:

```text
intent-first message pipeline
anti-garbage validation before saving items
task management view for edit/show task requests
ordered list parsing into separate floating tasks/calls
training report plus tentative training plan handling
tentative follow-up wording and actions
debug trace for the latest decision
tests for the real failure cases
```

Existing production pieces must remain intact:

```text
Telegram webhook
Postgres assistant schema
OpenAI transcription
reminders runner
cron-job.org delivery
/remindertest
V2 tables
Yandex calendar best-effort sync
```

### 13.21. Intent-first assistant implementation

Implemented without a new database migration. Existing `assistant.audit_log` is used for decision traces, and existing `planner_items.metadata` is used for list order, floating items, tentative flags, and training state.

Changed behavior:

```text
task-management phrases -> no new planner items; bot shows current tasks for editing
status questions -> schedule/status response instead of task creation
ordered bullet lists -> separate floating tasks/calls with preserved order
training missed reports -> saved as note/training report, not task title
tomorrow Holmy long ride -> tentative training plan with no arbitrary exact ride time
memory/correction phrases -> memory update, no item creation
AI planner fallback -> protected by anti-garbage validator before saving
active context retrieval -> best-effort; transient DB errors do not block message handling
tentative event follow-up -> asks whether the event happened or was cancelled
/tasks -> editable task-management view
/debuglast -> shows latest decision trace without secrets
```

Files added:

```text
src/ai/schemas/assistantDecision.ts
src/ai/assistantDecision.ts
src/ai/antiGarbageValidator.ts
src/services/assistantPlanBuilders.ts
src/bot/messagePipeline.ts
src/tests/assistantDecision.test.ts
```

Files updated:

```text
src/ai/schemas.ts
src/ai/heuristicActionPlanner.ts
src/ai/prompts/planner.system.ts
src/bot/commands.ts
src/bot/messageHandlers.ts
src/bot/messagePipeline.ts
src/bot/callbacks.ts
src/bot/formatters.ts
src/bot/keyboards.ts
src/db/queries/audit.ts
src/db/queries/items.ts
src/jobs/runDueReminders.ts
src/services/actionPlanCommit.ts
src/services/contextRetrieval.ts
```

Validation completed locally:

```text
npm test -> passed, 32 tests
npm run lint -> passed
npm run build -> passed
```

Additional production-hardening fix:

```text
active context retrieval can hit transient Neon connection errors
message pipeline now logs the context error, stores it in decision trace, and continues without blocking the user's request
```

New tests cover:

```text
edit task request creates zero new tasks
ordered task list becomes six separate items
training missed plus tentative Holmy ride does not become one task title
anti-garbage validator blocks command text as item title
tentative follow-up asks whether it happened or was cancelled
tentative training plan appears in day views
memory correction is classified as memory_update
command-like texts do not create tasks
```

### 13.22. Production deploy for intent-first assistant

Code was pushed to GitHub:

```text
commit -> 48f934e76d5e53e93637d8cd5cb1ef36ad3f1760
message -> Add intent-first assistant pipeline
```

Additional resilience fix was pushed:

```text
commit -> 4e027c4648678a4e6999bc0b566f66ace066d85c
message -> Make context retrieval best effort
```

Vercel production health confirmed:

```text
url -> https://znambo-telegram-assistant.vercel.app/api/health
ok -> true
deploymentCommit -> 4e027c4648678a4e6999bc0b566f66ace066d85c
calendarProvider -> yandex
yandexCalendarConfigured -> true
```

Telegram webhook check:

```text
webhook url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
pending_update_count -> 0
last_error_message -> null
```

Reminder runner check:

```text
POST /api/reminders/run -> ok: true
claimed -> 0
sent -> 0
failed -> 0
```

Local production DB synthetic verification status:

```text
direct local TCP queries to Neon intermittently returned read ECONNRESET
active context retrieval was made best-effort so this kind of transient context failure does not block message handling
fresh reminder creation from local scripts was not completed because inserts also hit ECONNRESET
```

Pending final manual verification:

```text
send /remindertest 2 in Telegram after this deploy
confirm the Telegram reminder arrives
record the result in PROJECT_HISTORY.md
```

### 13.23. Chat/version history file requirement

New operating rule from the user:

```text
after each message, maintain a file with chat history and version updates
```

Implementation:

```text
CHAT_HISTORY.md created at the project root
PROJECT_HISTORY.md remains the production rollout/history file
CHAT_HISTORY.md is now the turn-by-turn continuity log
```

Safety:

```text
do not write secrets, tokens, passwords, API keys, bearer tokens, database URLs, or private credentials into either history file
```

Attached context received in the same turn:

```text
a large Jarvis Mode specification for the next architecture step was attached
implementation of that specification has not started in this turn
```

### 13.24. Jarvis Mode MVP implementation

User request:

```text
implement the attached Jarvis Mode / agentic assistant specification without rewriting V2 from scratch
```

Implemented locally:

```text
added Jarvis Mode feature flag JARVIS_MODE_ENABLED, default true
added central src/agent/jarvisPipeline.ts
added deterministic Jarvis decision layer for plan views, task views, yesterday review, evening review, delete-by-index, done-by-index, cleanup, and undo
delegates real task/event/training/multi-action creation to the existing V2 smart planner
added rich context builder that includes active retrieval and latest task view state
added task view state storage so numbered lists can be managed later by messages like "delete 7-12 and 14"
added agent action history for debug/undo
added cleanup validator for debug/test/command-like garbage items
updated Telegram natural text and voice transcript flow to enter Jarvis Mode before V2 fallback
updated /today, /tomorrow, /week, /tasks to render through Jarvis tools and save task view state
added /review_yesterday, /cleanup_garbage, and /undo commands
updated inline done/delete/tentative callbacks to cancel future reminders for affected items
updated morning digest to include overdue open items so it does not look empty when yesterday has unfinished work
made Jarvis task-view retrieval, task-view save, and agent-action save best-effort so rollout does not break Telegram flow if migration 0002 is applied slightly later
```

Database changes:

```text
new migration drizzle/0002_jarvis_mode.sql
new assistant.task_view_states table
new assistant.agent_actions table
drizzle journal updated with 0002_jarvis_mode
```

New tests:

```text
Jarvis full-plan requests create zero tasks
delete ranges like 7-12 and 14 route to task-view tools
yesterday review creates zero tasks
real multi-action capture still delegates to V2 planner
task view state resolves display numbers to item ids
cleanup detects debug and command-like garbage
morning digest includes overdue open items
```

Validation completed locally:

```text
npm test -> passed, 39 tests
npm run lint -> passed
npm run build -> passed
checks were rerun after rollout-safety changes
```

Production status:

```text
deployed to Vercel production via GitHub auto-deploy
production commit -> beba0341a2800b00a4ea0f7096ed800f8f4ee4f2
0002_jarvis_mode migration applied to production Neon
assistant.task_view_states and assistant.agent_actions verified in schema assistant
health endpoint ok -> true
calendar provider -> yandex
Telegram webhook url -> https://znambo-telegram-assistant.vercel.app/api/telegram/webhook
Telegram webhook pending_update_count -> 0
Telegram webhook last_error_message -> null
POST /api/reminders/run after deploy -> ok true, claimed 0, sent 0, failed 0
direct production reminder smoke test -> claimed 1, sent 1, failed 0
reminder_deliveries row confirmed -> status sent with Telegram message id
temporary smoke-test planner item was cancelled after delivery so it does not remain in active tasks
manual /remindertest 2 from the user's Telegram client was not run by Codex because Bot API cannot send an inbound user command
```

### 13.25. Full production repair implementation

Root causes confirmed:

```text
Jarvis management handlers could still fall through to legacy V2 after a handler error
the old pending_action confirmation path could create a management phrase
daily digests used unbounded historical open-item queries
numbered renderers and task_view_state mapping were not one atomic operation
test reminders remained active after successful delivery
```

Implemented:

```text
central hard-management detector and deterministic router
hard guard before Jarvis AI, legacy V2, pending_action writes, and ActionPlan writes
safe no-create response when a management handler fails
reset_active_plan confirmation flow with all/garbage-only/show/cancel buttons
owner-only /admin_reset_active_plan command
soft archive, reminder-chain cancellation, calendar-sync-job cancellation, agent action snapshot, and undo
strict daily/evening/yesterday-carry/recent-range/full-plan queries
single renderAndSaveTaskView helper with exact sequential 1..N mapping
task_view_state persistence for morning and evening scheduled reviews
native recent-range rendering
known production pollution and giant multiline garbage detection
/remindertest metadata plus automatic archive after delivery
/debuglast pipeline markers
/api/health Jarvis mode marker
edited-message routing through the same guarded pipeline
```

Local validation:

```text
npm test -> 18 files passed, 56 tests passed
npm run lint -> passed
npm run build -> passed
git diff --check -> passed
```

## V2.5.3 production repair enforcement and CalDAV verification

Started from active production V2.5.2 commit
`1c209e03d2aba32dff95eb0f191d7df685819555`.

The protected production snapshot confirmed 12 visible active items, an orthodontist event still on
2026-06-13, stale/duplicate Drik intent, five unresolved records from 2026-06-07 through
2026-06-09, and a calendar test event whose CalDAV result was not visible.

Implemented:

```text
canonical buildUserTimelineView for tasks/dashboard/reminders/long-term
unresolved_past bucket after 48 hours
idempotent production repair behind /admin_repair_v252
safe /cleanup_garbage preview and /admin_state_v252
CalDAV PROPFIND/create/read/delete test
read-back verification after normal CalDAV PUT
safe calendar error classes and per-item calendar status
explicit calendar feedback after creates, updates and plan confirmations
```

Pre-deploy validation:

```text
npm test -> 41 files passed, 129 tests passed
npm run lint -> passed
npx tsc --noEmit -> passed
```

No secrets were written to project history. Production deployment, repair application and
acceptance checks are pending.

### V2.5.3 production rollout completed

Production acceptance:

```text
active tested code commit -> febedb885f05b4512dbce25d216b186b64aaf7f4
production URL -> https://znambo-telegram-assistant.vercel.app
health -> appVersion 2.5.3, Jarvis enabled, runner/reconciler enabled
webhook -> pending 0, no last error
repair preview before apply -> 1 orthodontist, 1 Drik duplicate, 5 old overdue, 1 stale bot card
repair apply -> fixed orthodontist, archived 1 Drik duplicate, moved 4 records to history state
repair preview after apply -> all target counts 0
dashboard -> compact "Со вчера / Неразобранное: 4" block
reminder smoke -> delivery sent, test item auto-archived
OpenAI health -> real call succeeded, structured output valid
exact orthodontist execution -> updated canonical orthodontist item, created 0 items
```

The production agent probe exposed one semantic binding bug: the first attempt selected a Drik task
that mentioned Rob. V2.5.3 was patched so orthodontist requests can bind only to orthodontist or
dentist context. The repeated production execution then updated the correct canonical item.

Yandex CalDAV verification is now honest and visible:

```text
calendar configured -> true
authorization -> failed
write -> failed
safe error class -> auth_failed
```

The app password must be corrected outside the repository before create/read/delete can pass.
Planner and Telegram reminder writes remain non-blocking. One future reminder-like item remains an
orphan candidate and was intentionally not auto-archived because it may be a real user task.

Final local validation:

```text
npm test -> 41 files passed, 130 tests passed
npm run lint -> passed
npm run build -> passed
secret scan -> no supplied secrets found in repository
```

One-time production cleanup status:

```text
direct local production Neon preview was attempted
Neon pooler and direct endpoint repeatedly returned ECONNRESET
no production cleanup mutation was applied without a reliable preview
the confirmed owner-only cleanup flow is ready for deployment
```

### 13.26. Production repair rollout and data cleanup

Production commits:

```text
d7ade75 Repair Jarvis production management flow
3b0230c Add protected production repair endpoint
100a7f4 Add production reminder smoke verification
```

Deployment verification:

```text
production URL -> https://znambo-telegram-assistant.vercel.app
health ok -> true
pipelineMode -> jarvis
jarvisModeEnabled -> true
deploymentCommit -> 100a7f4a7255eecea0a29963d96bf3fa42ee3ce0
Telegram webhook pending updates -> 0
Telegram webhook last error -> none
protected reminder runner -> ok true, claimed 0, sent 0, failed 0
```

One-time targeted production cleanup:

```text
preview open items -> 21
preview targeted garbage/test items -> 14
preview test items -> 2
preview attached active reminders -> 0
archived targeted garbage/test items -> 14
remaining active items -> 7
remaining garbage items -> 0
remaining test items -> 0
remaining attached active reminders -> 0
```

The archived set included:

```text
legacy giant multiline meeting
old Zoom setup/tentative call/Z2 test scenario
old calls and content tasks listed in the production incident
the erroneous delete-command planner item
two old reminder-test planner items
```

Production reminder smoke:

```text
created a protected production reminder smoke due in 2 minutes
did not manually invoke the reminder runner while waiting
automatic scheduler delivered the reminder
reminder status -> sent
delivery status -> sent
test planner item status -> cancelled
autoArchivedAfterDelivery -> true
post-smoke garbage/test preview -> 0
```

Final validation:

```text
npm test -> 18 files passed, 56 tests passed
npm run lint -> passed
npm run build -> passed
```

Remaining operational limitation:

```text
best-effort external calendar entries are not deleted during active-plan reset; their pending sync jobs are cancelled and the assistant database remains the source of truth
```

### 13.27. Mandatory OpenAI observability and agent execution rollout

Production incident:

```text
The headed list "На сегодня" was bypassing OpenAI and was saved by the deterministic ordered-list path.
The three timed entries became generic tasks due at 23:59.
The relative instruction about every event was saved as a fourth generic task.
decideUserIntentWithAI did not call OpenAI at all.
The legacy ActionPlan builder silently used heuristic fallback after OpenAI errors.
```

Implemented:

```text
all non-command natural-language turns now use the mandatory Jarvis agent pipeline
OPENAI_REQUIRED_FOR_NATURAL_LANGUAGE defaults to true
only exact saved-view index operations remain deterministic natural-language operations
OpenAI failures are fail-closed and cannot create or update planner items
the agent uses a forced strict Responses API function tool with Zod validation
one schema-only retry is allowed; authentication, rate-limit and network failures are not hidden
the model must choose one primary execution path per turn
relative references receive real planner item IDs and latest task-view IDs in retrieval context
model-proposed item updates create before-event reminders, follow-ups and management metadata
task management keyboards now include separate edit controls
recently missed follow-ups receive an idempotent one-minute catch-up
```

Per-turn audit telemetry stored in `assistant.audit_log`:

```text
pipelineUsed
preRouterIntent
aiRequired
aiCalled
aiSucceeded
aiModel
openaiResponseId
requestStartedAt
requestFinishedAt
latencyMs
inputTokens
outputTokens
totalTokens
structuredOutputValid
toolCallsProposed
toolCallsExecuted
fallbackUsed
fallbackReason
validationWarnings
finalAction
createdItemIds
updatedItemIds
errorCode
safeErrorMessage
```

Operational diagnostics:

```text
/aihealth performs a real minimal Responses API request with a harmless strict tool
/debuglast renders the latest mandatory AI trace
/api/health exposes only safe OpenAI status fields
the protected production probe can verify model proposals without mutating user data
the protected confirmed execution probe verifies model proposal -> validation -> DB tool execution
```

Production proof on behavioral commit `4fb97b3528b0eb9793b79b23f36538548a578ba9`:

```text
health ok -> true
openAiConfigured -> true
openAiRequiredForNaturalLanguage -> true
lastAiModel -> gpt-4o-mini-2024-07-18
lastAiErrorType -> null
Telegram webhook pending updates -> 0
Telegram webhook last error -> none
reminder runner -> ok
```

Real OpenAI health call:

```text
aiCalled -> true
aiSucceeded -> true
structuredOutputValid -> true
toolCallsProposed -> report_ai_health
model -> gpt-4o-mini-2024-07-18
a safe OpenAI response ID and token usage were returned and audited
no planner items were created
```

Exact production list execution:

```text
input -> headed three-item "На сегодня" list from the incident
toolCallsProposed -> create_action_plan
toolCallsExecuted -> create_action_plan
fallbackUsed -> false
created items -> 3
kinds -> event, event, training
titles -> Красочный забег, Эфир ВС, Тренировка Z2
local start times -> 10:00, 13:00, 22:00
dueAt -> null for all three
```

Exact production relative update execution:

```text
input -> remind one hour before every event, ask afterwards, expose separate management controls
toolCallsProposed -> update_existing_items
toolCallsExecuted -> update_existing_items
fallbackUsed -> false
updated items -> the same 3 created item IDs
managementButtonsRequested -> true for all three
future reminders/follow-ups were created
past one-hour reminders were reported as validation warnings instead of backdated
the recently missed race follow-up was scheduled as an idempotent catch-up
```

Automatic delivery proof:

```text
the model-driven catch-up reminder was not run manually
cron-job.org claimed it automatically
reminder status -> sent
delivery status -> sent
Telegram delivery timestamp was recorded
```

Production data repair:

```text
preview found exactly four records from the reported incident
three generic 23:59 tasks and the generic management-instruction task were archived
post-cleanup targeted garbage count -> 0
the corrected model-driven records were then created through the protected execution proof
```

Final validation:

```text
npm test -> 20 files passed, 64 tests passed
npm run lint -> passed
npm run build -> passed
```

Remaining limitation:

```text
the protected execution proof does not render a Telegram summary card itself
the normal webhook path uses the same proposal, validator, commit and update services and adds the user-facing summary/buttons
```

### 13.28. V2.5.1 compact control, priority and temporal semantics

Implemented:

```text
compact chat orchestrator with dashboard-before-reminder ordering and one active reminder slot
bot-only stale card cleanup; user messages remain outside the lifecycle registry
semantic timeline classification and effective priority escalation
priority-sorted distant dashboard section
interactive reminder control center with policy cards, priority, interval, pause/resume and cancel
policy version audit and /undo fallback
upcoming-night NBA 03:30 normalization and explicit reminder-time validation
repair-in-place correction path for existing night events
sequential Central Park reminder activation boundary and grouped campaign rendering
durable daily snapshots in audit_log plus history commands
compact voice processing and /lasttranscript
owner-only /admin_repair_v251 preview|apply
```

Preserved:

```text
runner lease
reconciler before claim
anchor-grid-v2
snooze as one-off
atomic action-plan commit
```

Local validation before deployment:

```text
npm test -> 37 files passed, 114 tests passed
npm run lint -> passed
npm run build -> passed
```

### 13.28. V2.3.0 contextual planner operations

Fresh production behavior report:

```text
a generic completion reply after a follow-up updated three items instead of completing one
a hybrid "show today + add preparation" request copied existing event/training context into new records
time-change replies did not reliably mutate start/end fields
one event update produced duplicate titles in the response
configured follow-ups did not expose the requested per-item management controls
```

Implemented:

```text
itemUpdates now use typed operations: configure, complete, reschedule
reschedule supports explicit local start and end datetime fields
multiple updates for the same item ID are merged before one DB mutation
completion cancels the completed item's future reminder chain
reschedule preserves and recalculates active reminder policies
configured follow-ups show Done, Reschedule, Edit and Delete buttons
the latest delivered follow-up is included in retrieval context
generic completion replies bind to one fresh follow-up item for 45 minutes
stale task-view snapshots are reloaded from current planner rows and filtered to active items
non-active planner IDs cannot be mutated
events are included in manageable current-item retrieval
explicit clock times in source text are checked against proposed ISO times before DB writes
hybrid create-plus-view requests support a post-execution view
ActionPlans are deduplicated against active items before commit
same-day task/preparation entries with the same title are treated as duplicates
```

Version reporting:

```text
application version -> 2.3.0
/api/health now exposes appVersion
versions/README.md defines the per-version file rule
separate summaries created for V2.0.0, V2.1.0, V2.2.0 and V2.3.0
```

Production repair and verification:

```text
two confirmed late duplicate records were archived
one preparation duplicate created by the protected hybrid verification was archived
the original records and their reminder policies were preserved
two-item reschedule executed against preparation and training IDs
event range reschedule executed against one active event ID
final local schedule -> Эфир ВС 13:00-20:00, Подготовка к ЧМ 22:00, Тренировка Z2 23:00
hybrid verification after dedup created no new items
Telegram webhook pending updates -> 0
Telegram webhook last error -> none
reminder runner -> ok
```

Validation:

```text
npm test -> 22 files passed, 75 tests passed
npm run lint -> passed
npm run build -> passed
behavioral production commit -> 29cbfa7efcd1e1b8dd47131d32f3696da6d7d01b
```

Remaining limitations:

```text
the contextual follow-up anchor expires after 45 minutes
calendar synchronization remains best-effort
```

### 13.29. V2.4.0 Live Plan Dashboard and Reminder Policy Engine

Implemented:

```text
new migration drizzle/0003_live_dashboard_reminder_policies.sql
live dashboard table and service with one active dashboard per chat
Telegram message registry with safe delete and keyboard-disable fallback
reminder policy and policy occurrence tables
policy-backed ActionPlan reminders
typed OpenAI reminderPolicies execution schema
interval-window policies that create only the next occurrence
weekly, biweekly, nag-until-ack and long-term policy support
neutral post-event reaction menus
dashboard refresh after planner mutations, callbacks and reminder delivery
/dashboard, /reminders, /longterm and /cleanup_chat
```

Regression coverage:

```text
old dashboard is retired before a new dashboard is registered
event due delivery exposes reaction actions instead of a single question
interval window creates one policy and one next reminder
interval policy advances one occurrence at a time
weekly mirror and biweekly ЖКХ rules remain long-term policies
failed Telegram deletion disables the stale card
all V2.3 regressions remain green
```

Pre-production validation:

```text
npm test -> 26 files passed, 83 tests passed
npm run lint -> passed
npm run build -> passed
```

Initial production rollout:

```text
production commit -> 96b41f088ea8aea956d0f0bbf195388027591cd4
health -> appVersion 2.4.0, live dashboard enabled, policy engine enabled
Telegram webhook -> pending 0, last error none
reminder runner -> 200 OK
all four V2.4 tables and planner/reminder V2.4 columns verified in Neon
protected agent probe extended to expose and execute reminder policy proposals
```

### 13.30. V2.4.0 final production policy verification

Production probes first proved that OpenAI was called successfully but exposed weak model
classification for interval, weekly/biweekly and every-event reminder requests.

Implemented without bypassing mandatory AI:

```text
post-AI semantic normalization after a valid OpenAI structured tool call
interval-window correction to one task plus one policy
weekly and biweekly correction to long-term recurring policies
every-event before/post correction to update_existing_items
expanded protected probe fields for due time, categories, windows and requireAck
```

Final validation:

```text
npm test -> 27 files passed, 87 tests passed
npm run lint -> passed
npm run build -> passed
verified behavioral production commit -> b90bdcfc0e2ba4fdf322a2d233ececcbeec37d24
OpenAI production health -> succeeded, structured output valid, response ID present
daily-list production probe -> event, event, training at 10:00, 13:00 and 22:00
interval production probe -> one task due 11:00 and one 08:00-11:00 policy every 30 minutes
weekly/biweekly production probe -> recurring_car weekly and recurring_finance every_2_weeks
before/post production probe -> existing active IDs updated, no generic task proposed
/api/health -> ok, appVersion 2.4.0
Telegram webhook -> pending 0, no last error
reminder runner -> 200 OK, failed 0
```

Remaining manual acceptance:

```text
visually confirm dashboard replacement and reaction-menu callback cleanup in Telegram
```

### 13.31. V2.4.1 Reminder Reliability Repair

Implemented:

```text
drizzle/0004_reminder_reliability_repair.sql
policy reconciler before every reminder claim
idempotent occurrence/reminder recovery
interval progression from occurrence.scheduledFor without delivery drift
one-immediate catch-up without missed-slot bursts
inclusive interval window ends
user and policy quiet hours
scheduler runtime health, /cronhealth and /policydebug
safe scheduler fields in /api/health
nested reminder policy setup and expanded snooze controls
Telegram cleanup audit with planner mutation explicitly forbidden
legacy diagnostics in /reminders and /longterm
owner-only preview/apply repair for circle, Drik, mirror and ЖКХ
```

Production rollout:

```text
implementation commit -> 9f80c4ab8a2697cc8fcac1955c3902c0131e8bc2
verified production commit -> 81188bb3d74745514836c6103eebef49ea456437
production health -> appVersion 2.4.1
new scheduler and policy schema objects -> read successfully by production
Telegram webhook -> pending 0, no last error
cron-job.org -> automatic successful runner observed
repair preview -> exactly four intended legacy groups
repair apply -> 4 items repaired, 4 policies created, no unrelated records changed
active policies -> 4
policies missing next reminder -> 0
circle and Drik catch-up slots -> advanced automatically from 10:00 to 10:30 Moscow
circle 10:30 reminder -> delivered automatically by cron-job.org
circle Done callback -> item completed, policy completed, future reminder cancelled
Drik catch-up snooze -> pending reminder rescheduled to 10:44 Moscow
mirror -> weekly long-term recurring_car policy
ЖКХ -> every_2_weeks long-term recurring_finance policy
OpenAI health -> real call succeeded with valid structured output and accepted tool definition
```

Validation:

```text
npm test -> 31 files passed, 95 tests passed
npm run lint -> passed
npm run build -> passed
```

Remaining limitation:

```text
Vercel project scope requires CLI/connector re-authentication; GitHub auto-deploy remains operational
```

### 13.32. V2.4.2 Transactional Reminder Semantics

Production incident:

```text
Snooze shifted the Drik interval grid from :00/:30 to :14/:44.
Near the end of the window duplicate deliveries appeared.
An expired interval task produced a post-event menu after midnight.
The Central Park request partially mutated production despite a validation failure.
An open-ended Drik request became a generic task without a working policy.
Tomorrow's one-day reminder was classified as long-term.
```

Implemented:

```text
distributed 55-second reminder runner lease in assistant.runtime_locks
reconciler-before-claim runner order
anchor-grid-v2 interval calculation based on policy.startsAt
one-off snooze reminders that do not move the policy grid
strict inclusive end-window handling with expire_silently default
atomic ActionPlan, planner item, policy, initial reminder and occurrence commit
pre-commit semantic validation for reminder policies
transaction telemetry for proposed and committed mutations
exact Central Park normalization to two events and four daily policies
open-ended Drik normalization to one task and one 08:00-22:00 nag_until_ack policy
dashboard sections for active, soon and distant reminders
owner-only /admin_repair_v242 preview|apply
/versiondebug and safe scheduler/version fields in /api/health
```

The first production preview additionally exposed two partial Central Park policies and one Drik
interval stored with the invalid `recurring` type. The repair filter was tightened to include those
exact known signatures before any mutation was applied.

The first corrected Central Park production attempt was atomically blocked by a validator false
positive: the word `утром` was treated as an imprecise window despite the explicit `с 8 до 12`
range. The validator now distinguishes a vague day-part from an explicit numeric clock/range.

A protected self-cleaning snooze probe was added because direct local Neon pooler connections are
unstable. It creates a temporary 10-minute interval policy, snoozes by 13 minutes, reports the
resulting timestamps and deletes the entire probe chain in `finally`.

The first production run of the probe proved the grid behavior but revealed that the existing
production schema does not cascade planner item deletion to reminder policies. Probe cleanup was
therefore changed to explicitly delete probe reminders, policies and items.

A protected read-only dashboard snapshot was added for production acceptance of the same renderer
used by `/dashboard`.

Database rollout:

```text
drizzle/0005_transactional_reminder_semantics.sql applied idempotently
assistant.reminder_policies.on_window_end exists
assistant.runtime_locks exists
reminder occurrence and lock indexes exist
Neon pooler disconnected during the broad diagnostic read after DDL; the DDL notices confirmed all
objects were already present on retry, and runtime verification will confirm them through V2.4.2
```

Local validation:

```text
npm test -> 34 files passed, 105 tests passed
npm run lint -> passed
npm run build -> passed
```

Production deployment and acceptance are pending the GitHub/Vercel rollout of this working tree.

Production rollout completed:

```text
active production commit -> 06e111e2268af137afa18fbbfe6475187e4497e8
production URL -> https://znambo-telegram-assistant.vercel.app
/api/health -> ok, appVersion 2.4.2, policyEngineVersion 2.4.2
intervalAlgorithmVersion -> anchor-grid-v2
reconcilerEnabled -> true
runnerLockEnabled -> true
activePolicyCount -> 7 after repair and acceptance records
policiesMissingNextReminder -> 0
Telegram webhook -> pending 0, no last error
OpenAI health -> real call succeeded, structured output valid, tool call accepted
V2.4.2 repair preview before apply -> 1 orphan Drik task, 1 malformed Drik policy, 2 partial Central Park policies, 3 future reminders
V2.4.2 repair apply -> archived 1 item, expired 3 policies, cancelled 3 future reminders
V2.4.2 repair preview after apply -> 0 items, 0 policies, 0 future reminders, 0 shifted reminders
Central Park exact production execution -> 2 events, 4 daily policies, no validation warnings
Open-ended Drik exact production execution -> 1 task, 1 nag_until_ack policy, 08:00-22:00, interval 30, requireAck true
snooze production probe -> snooze one-off, next regular returned to original 10-minute grid, gridPreserved true
snooze probe cleanup -> no probe policies remain after probe
concurrent runner requests -> one executed, one skipped with runner_already_active
dashboard snapshot -> Drik under Скоро; mirror and ЖКХ under Дальние
```

Final validation for code commits in this rollout:

```text
npm test -> 34 files passed, 105 tests passed
npm run lint -> passed
npm run build -> passed
secret scan -> no provided secrets found in repository files
```

Remaining limitations:

```text
Yandex Calendar remains best-effort; failures must not block planner/reminder writes.
Vercel CLI/connector auth is still unavailable locally, but GitHub auto-deploy is working.
Direct local Neon pooler connections are still unreliable; protected server-side diagnostics are the reliable production path.
```

## V2.5.2 universal editability and temporal safety

V2.5.2 added universal entity cards and opening buttons across dashboard, tasks, reminder views and
daily history. Reminder policies link back to items, item cards always expose reminder controls,
and campaigns have their own management card.

Raw `P3/P4` labels were removed from normal UI. Importance now keeps `importanceMode`,
`basePriority`, effective priority and urgency boost separate. Timeline classification now includes
`distant_priority` and `campaign_active`.

The deterministic Russian weekday layer resolves `во вторник к 10.20` from Thursday 2026-06-11 to
Tuesday 2026-06-16 10:20. Medical/family appointments receive health metadata, automatic base
importance 4 and reminder suggestions. Repeated requests now open existing records instead of
silently no-oping.

Future campaign events cannot be completed by an accidental early `Done`. The bot asks whether
preparation is done, the event passed, it was cancelled, or it should be rescheduled. Only explicit
event completion or manual activation advances the campaign.

Owner-only `/admin_repair_v252 preview|apply` fixes the orthodontist record, invokes the existing
malformed/Central Park repair, marks legacy Drik orphans, archives old overdue records, marks old
bot cards stale, preserves user messages, and saves an audit rollback snapshot.

Local validation:

```text
npm test -> 39 files passed, 123 tests passed
npm run lint -> passed
npx tsc --noEmit -> passed
npm run build -> passed
git diff --check -> passed
```

## V2.9.0 deadline semantics and due-task production rollout

V2.9.0 introduced explicit deadline semantics on top of the existing mandatory OpenAI planner.
Deadline phrases now persist to `planner_items.due_at`; `start_at/end_at` are used only when the
user explicitly names a work interval. No database migration was required.

Implemented:

```text
deadline parser and post-AI semantic normalization
separate Plan and task-card rendering for scheduled time and due time
deadline reminder presets for future and same-day deadlines
item-context set/change/clear deadline edits
safe /admin_repair_v290 preview|apply
project-name normalization for Больше, Централ Парк and ЧМ-26
```

Validation and production acceptance:

```text
npm test -> 52 files, 217 tests passed
npm run lint -> passed
npx tsc --noEmit -> passed
npm run build -> passed
git diff --check -> passed
secret scan -> passed
active production commit -> 9de4c1a53c2160b447e10899e0eb40c3eec76b3c
/api/health -> appVersion 2.9.0, matching deployment commit
Telegram webhook -> correct URL, pending 0, no last error
exact production AI probe -> one task, no scheduled block, due June 15 at 14:00
repair -> one exact bad item converted in place; zero calendar objects changed
repair preview after apply -> zero candidates
Plan snapshot -> Monday deadline visible; accidental 12:00-14:00 range absent
automatic reminder smoke -> sent to Telegram and auto-archived
cron-job.org runner -> healthy after deployment
```

The inline deadline reminder buttons were validated by automated tests. They were not manually
clicked in the owner's Telegram chat during this rollout. No secrets were written to history.

## V2.10.0 recurring policy execution and end-of-day fix

V2.10.0 completes the recurring-policy path already produced by the mandatory OpenAI planner.
Weekly weekday rules and monthly day ranges are stored as canonical typed recurrence strings,
materialized by the existing policy engine, and advanced after delivery in the user's timezone.

Missing reminder time no longer causes a generic failed-closed response. The bot stores a typed
draft, shows one multi-policy summary, and asks only for the missing time. Cadence phrases are not
allowed to become task titles. Reminder setup sessions also accept stop-condition-only replies and
continue with the next missing interval or window field.

The release fixes local `сегодня до конца дня` and `завтра до конца дня` semantics at 23:59,
adds targeted recurring tool diagnostics to `/debuglast`, and introduces the conservative
`/admin_repair_v2100 preview|apply` command. The repair changes no Yandex Calendar objects.

Pre-deployment validation:

```text
npm test -> 53 files, 234 tests passed
npm run lint -> passed
npx tsc --noEmit -> passed
npm run build -> passed
git diff --check -> passed
database migration -> not required
```

No secrets were written to project history.
