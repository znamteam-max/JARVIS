"""Run: python -I ops/watchdog/test_jarvis_watchdog.py"""

import importlib.util
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_watchdog(base_dir: str):
    os.environ["JARVIS_OPS_DIR"] = base_dir
    spec = importlib.util.spec_from_file_location("jarvis_watchdog", HERE / "jarvis_watchdog.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.time.sleep = lambda _seconds: None
    return module


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        (base / "secrets").mkdir()
        (base / "secrets" / "ops_watchdog_secret").write_text("TEST_SECRET\n", encoding="utf-8")
        self.wd = load_watchdog(self.tmp.name)
        self.sent: list[str] = []
        self.health = {"ok": True, "lastRunnerSucceeded": True}
        self.webhook = {"ok": True, "webhookConfigured": True, "pendingUpdateCount": 0}

        def fake_http_json(url, data=None, secret=None):
            if url.endswith("/api/health"):
                if self.health is None:
                    raise self.wd.urllib.error.URLError("down")
                return self.health
            self.assertTrue(url.endswith("/api/ops/watchdog"), url)
            self.assertEqual(secret, "TEST_SECRET")
            if data["action"] == "webhook_info":
                return self.webhook
            if data["action"] == "alert":
                self.sent.append(data["text"])
                return {"ok": True}
            raise AssertionError(data)

        self.wd.http_json = fake_http_json

    def tearDown(self):
        self.tmp.cleanup()

    def at(self, minutes: int) -> datetime:
        return datetime(2026, 10, 9, 7, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)

    def fresh_runner(self, now: datetime):
        self.health["lastRunnerRunAt"] = (now - timedelta(minutes=1)).isoformat()

    def test_healthy_bot_sends_nothing(self):
        now = self.at(0)
        self.fresh_runner(now)
        self.assertEqual(self.wd.run(now), 0)
        self.assertEqual(self.sent, [])

    def test_stale_runner_alerts_on_second_check_then_hourly_then_recovers(self):
        self.health["lastRunnerRunAt"] = self.at(-30).isoformat()
        self.wd.run(self.at(0))
        self.assertEqual(self.sent, [], "one failed check is not enough")
        self.wd.run(self.at(5))
        self.assertEqual(len(self.sent), 1)
        self.assertIn("напоминания не запускались", self.sent[0])
        self.wd.run(self.at(10))
        self.assertEqual(len(self.sent), 1, "no repeat within the hour")
        self.wd.run(self.at(66))
        self.assertEqual(len(self.sent), 2, "hourly repeat")
        self.fresh_runner(self.at(70))
        self.wd.run(self.at(70))
        self.assertEqual(len(self.sent), 3)
        self.assertIn("снова в порядке", self.sent[-1])

    def test_unreachable_site_and_failing_webhook(self):
        self.health = None
        self.webhook.update(
            pendingUpdateCount=12,
            lastErrorDate=int(self.at(-1).timestamp()),
            lastErrorMessage="Wrong response from the webhook: 500",
        )
        self.wd.run(self.at(0))
        self.wd.run(self.at(5))
        self.assertEqual(len(self.sent), 1)
        self.assertIn("сайт бота не отвечает", self.sent[0])
        self.assertIn("не может доставить боту 12", self.sent[0])

    def test_short_blip_never_alerts_or_reports_recovery(self):
        self.health["lastRunnerRunAt"] = self.at(-30).isoformat()
        self.wd.run(self.at(0))
        self.fresh_runner(self.at(5))
        self.wd.run(self.at(5))
        self.assertEqual(self.sent, [])
        state = json.loads((Path(self.tmp.name) / "state" / "watchdog_state.json").read_text())
        self.assertEqual(state["problems"], {})


if __name__ == "__main__":
    unittest.main()
