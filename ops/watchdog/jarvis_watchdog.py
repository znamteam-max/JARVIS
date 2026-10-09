#!/usr/bin/env python3
"""External watchdog for the JARVIS bot.

Runs on a separate server every few minutes (systemd timer). It cannot live inside
the bot: if the bot or its scheduler stops, nothing inside it would report that.

Checks:
  * the live /api/health answers;
  * the reminder runner ran recently and its last run succeeded;
  * Telegram can deliver updates to the webhook (getWebhookInfo).

A problem is reported after two failed checks in a row, repeated hourly while it
lasts, and followed by a recovery message. Alerts go to the owner from the JARVIS
bot itself through its /api/ops/watchdog relay: the server cannot reach
api.telegram.org, and the relay has no DB dependency. Standard library only.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_DIR = Path(os.environ.get("JARVIS_OPS_DIR", "/opt/jarvis-ops"))
CONFIG_PATH = BASE_DIR / "watchdog.json"
SECRET_PATH = BASE_DIR / "secrets" / "ops_watchdog_secret"
STATE_PATH = BASE_DIR / "state" / "watchdog_state.json"

DEFAULT_CONFIG = {
    "app_url": "https://znambo-telegram-assistant-eta.vercel.app",
    "runner_stale_minutes": 10,
    "webhook_pending_threshold": 5,
    "webhook_error_window_minutes": 10,
    "confirm_failures": 2,
    "repeat_alert_minutes": 60,
}

HTTP_TIMEOUT_SECONDS = 20
MSK = timezone(timedelta(hours=3))


def load_json(path: Path, default: dict) -> dict:
    try:
        return {**default, **json.loads(path.read_text(encoding="utf-8"))}
    except FileNotFoundError:
        return dict(default)


def save_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def http_json(url: str, data: dict | None = None, secret: str | None = None) -> dict:
    headers = {"User-Agent": "jarvis-watchdog/1"}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def check_health(config: dict, now: datetime) -> dict[str, str]:
    """Returns {problem_key: human message}; empty when healthy."""
    url = config["app_url"].rstrip("/") + "/api/health"
    health = None
    error = ""
    for attempt in range(2):
        try:
            health = http_json(url)
            break
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            error = type(exc).__name__
            if attempt == 0:
                time.sleep(5)
    if health is None:
        return {"health_unreachable": f"сайт бота не отвечает ({error})"}

    problems: dict[str, str] = {}
    if health.get("ok") is not True:
        problems["health_not_ok"] = "бот сообщает, что он не в порядке (ok=false)"
    last_run = parse_iso(health.get("lastRunnerRunAt"))
    if last_run is None:
        problems["runner_unknown"] = "нет данных о запуске напоминаний"
    else:
        age = (now - last_run).total_seconds() / 60
        if age > int(config["runner_stale_minutes"]):
            problems["runner_stale"] = (
                f"напоминания не запускались {int(age)} мин "
                "(внешний планировщик cron-job.org мог остановиться)"
            )
    if health.get("lastRunnerSucceeded") is False:
        problems["runner_failed"] = "последний запуск напоминаний завершился с ошибкой"
    return problems


def relay_url(config: dict) -> str:
    return config["app_url"].rstrip("/") + "/api/ops/watchdog"


def check_webhook(config: dict, secret: str, now: datetime) -> dict[str, str]:
    try:
        info = http_json(relay_url(config), {"action": "webhook_info"}, secret)
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        # The site check already reports an unreachable bot; don't double-count it.
        print(f"webhook_info failed: {type(exc).__name__}", file=sys.stderr)
        return {}
    problems: dict[str, str] = {}
    if not info.get("webhookConfigured"):
        problems["webhook_missing"] = "у бота не настроен webhook — сообщения не доходят"
    pending = int(info.get("pendingUpdateCount") or 0)
    last_error = info.get("lastErrorDate")
    window = int(config["webhook_error_window_minutes"]) * 60
    recent_error = bool(last_error) and now.timestamp() - int(last_error) < window
    if recent_error and pending >= int(config["webhook_pending_threshold"]):
        problems["webhook_failing"] = (
            f"Telegram не может доставить боту {pending} сообщ. "
            f"({info.get('lastErrorMessage') or 'ошибка'})"
        )
    return problems


def send(config: dict, secret: str, text: str) -> bool:
    try:
        result = http_json(relay_url(config), {"action": "alert", "text": text}, secret)
        return bool(result.get("ok"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        print(f"alert relay failed: {type(exc).__name__}", file=sys.stderr)
        return False


def run(now: datetime | None = None, *, test_alert: bool = False) -> int:
    now = now or datetime.now(timezone.utc)
    config = load_json(CONFIG_PATH, DEFAULT_CONFIG)
    try:
        secret = SECRET_PATH.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        print(f"secret file missing: {SECRET_PATH}", file=sys.stderr)
        return 2
    if test_alert:
        ok = send(
            config,
            secret,
            "🛡 Сторож JARVIS подключён. Если бот перестанет работать, я напишу сюда.",
        )
        return 0 if ok else 1

    state = load_json(STATE_PATH, {"problems": {}})
    known: dict = state.get("problems", {})
    current = {**check_health(config, now), **check_webhook(config, secret, now)}
    confirm = int(config["confirm_failures"])
    repeat_seconds = int(config["repeat_alert_minutes"]) * 60

    alerted: list[str] = []
    for key, message in current.items():
        entry = known.get(key) or {"since": now.isoformat(), "failures": 0, "alerted_at": None}
        entry["failures"] = int(entry.get("failures", 0)) + 1
        entry["message"] = message
        last_alert = parse_iso(entry.get("alerted_at"))
        if entry["failures"] >= confirm and (
            last_alert is None or (now - last_alert).total_seconds() >= repeat_seconds
        ):
            alerted.append(key)
        known[key] = entry

    recovered = [
        entry.get("message", key)
        for key, entry in known.items()
        if key not in current and entry.get("alerted_at")
    ]
    for key in [key for key in known if key not in current]:
        del known[key]

    if alerted:
        text = "⚠️ JARVIS: что-то сломалось\n\n" + "\n".join(
            f"• {known[key]['message']}" for key in alerted
        )
        text += (
            f"\n\nПроверено {now.astimezone(MSK):%d.%m %H:%M} МСК. "
            "Напомню через час, если не починится."
        )
        # Only mark as alerted once Telegram accepted it, so a failed send retries next run.
        if send(config, secret, text):
            for key in alerted:
                known[key]["alerted_at"] = now.isoformat()
    if recovered:
        send(
            config,
            secret,
            "✅ JARVIS снова в порядке\n\n" + "\n".join(f"• было: {m}" for m in recovered),
        )

    state["problems"] = known
    state["last_check_at"] = now.isoformat()
    state["last_check_ok"] = not current
    save_json(STATE_PATH, state)
    print(json.dumps({"problems": sorted(current), "alerted": len(alerted)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(run(test_alert="--test-alert" in sys.argv[1:]))
