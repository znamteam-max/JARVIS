# Claude Code → JARVIS project log

A Claude Code `Stop` hook that keeps the Projects tab current without typing anything:
after every Claude reply it sends the turn (what the owner asked, what Claude answered,
the repo and branch) to JARVIS. The Mini App then shows, per session, one growing
«Сделано» line and the open «Впереди» steps, marked «Claude Code».

How it flows:

1. `jarvis-report.mjs` runs at the end of each turn, reads the session transcript and
   `POST`s the last turn to `/api/projects/session-report` (bearer `PROJECT_REPORT_TOKEN`).
   It waits at most 4 s, prints nothing and always exits 0, so it can never block or
   break a session.
2. The endpoint only stores the session's latest report and answers `202`. The project is
   found by its GitHub repo, else by a title equal to the folder name, else created.
3. The minute scheduler tick (`/api/reminders/run`) picks sessions that have been quiet
   for 90 s (or waited 15 min during a long busy session), asks Claude
   (`CLAUDE_REPORT_MODEL`, OpenAI as the fallback) what is done so far and what is next,
   and writes the log lines. The raw text is deleted once processed.

Only git projects report. Work projects never do: anything whose folder, GitHub owner or
repo name starts with `RNGN` (any case) is skipped before the transcript is even read, and
this cannot be turned off from the config. More patterns can be added to the config's
`exclude` list (`*` is any text), and a folder can also opt out with an empty
`.jarvis-ignore` file in the repo root. Obvious secrets (API keys, tokens, `Bearer …`, `*_TOKEN=…`, database URLs) are
replaced with `[redacted]` before anything is stored or sent to a model.

## Set up

1. Vercel: set `PROJECT_REPORT_TOKEN` to a long random string and redeploy. Apply
   `drizzle/0019_project_session_reports.sql` (after `0018_projects.sql`).
2. This computer: create `~/.claude/jarvis-report.json` (it holds a secret; keep it out of
   any repo):

   ```json
   {
     "url": "https://znambo-telegram-assistant-eta.vercel.app",
     "token": "<the same PROJECT_REPORT_TOKEN>",
     "exclude": []
   }
   ```

   `JARVIS_REPORT_URL` / `JARVIS_REPORT_TOKEN` environment variables work too and win over
   the file.

3. Add the hook to `~/.claude/settings.json` (merge with any hooks already there):

   ```json
   {
     "hooks": {
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "node \"C:/Users/znambo/GitHub/JARVIS/ops/claude-code/jarvis-report.mjs\"",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

Without the config file the hook does nothing, so it is safe to install first and turn on
later.

## Import all projects

`import-projects.mjs` puts every folder of `~/GitHub` (or `--dir <path>`) into the Projects
tab at once: its recent commits, branch, uncommitted changes and README. Work projects
(RNGN*) are skipped here and refused by the server. Running it again adds nothing twice;
JARVIS then writes each project's summary by itself, one per scheduler tick.

```bash
node ops/claude-code/import-projects.mjs --dry-run
```

```bash
node ops/claude-code/import-projects.mjs
```

## Check

A dry run prints the report the hook would send for a transcript, without sending it:

```bash
node --input-type=module -e "import { buildReport } from './ops/claude-code/jarvis-report.mjs'; console.log(buildReport({ session_id: 'dry-run', transcript_path: process.argv[1], cwd: process.cwd() }))" <path-to-a-session.jsonl>
```

Tests: `src/tests/claudeCodeReportHook.test.ts` (the hook) and
`src/tests/projectSessionReports.test.ts` (the server side).
