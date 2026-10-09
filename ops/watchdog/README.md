# JARVIS watchdog

External check that tells the owner in Telegram when the bot stops working.
It runs on the HoH VPS (`ssh hoh`, `/opt/jarvis-ops`), not inside the bot: a broken
bot or a stopped scheduler cannot report itself.

Every 5 minutes (`jarvis-watchdog.timer`) it checks:

- the live `/api/health` answers (`https://znambo-telegram-assistant-eta.vercel.app`);
- the reminder runner ran within the last 10 minutes and its last run succeeded;
- Telegram can deliver updates to the webhook.

A problem is reported after two failed checks in a row, repeated hourly while it lasts,
and followed by "✅ JARVIS снова в порядке".

The server cannot reach `api.telegram.org`, so alerts and the webhook check go through
the bot's own relay `POST /api/ops/watchdog` (bearer `OPS_WATCHDOG_SECRET`, no database
access). The relay is the only thing that needs the Vercel side to be up.

## Install / update

```bash
tar cf - install.sh jarvis-watchdog.service jarvis-watchdog.timer jarvis_watchdog.py \
  | ssh hoh 'd=$(mktemp -d); cd $d && tar xf - && sh install.sh; rm -rf $d'
```

The first install generates `/opt/jarvis-ops/secrets/ops_watchdog_secret`. Put the same
value into Vercel as `OPS_WATCHDOG_SECRET`, redeploy, then enable the timer:

```bash
ssh hoh 'cd /tmp && sudo -u jarvisops env JARVIS_OPS_DIR=/opt/jarvis-ops python3 -I /opt/jarvis-ops/bin/jarvis_watchdog.py --test-alert && systemctl enable --now jarvis-watchdog.timer'
```

Tests: `python -I ops/watchdog/test_jarvis_watchdog.py`.
State: `/opt/jarvis-ops/state/watchdog_state.json`; logs: `journalctl -u jarvis-watchdog`.
