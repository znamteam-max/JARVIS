#!/bin/sh
# Installs/updates the JARVIS watchdog on the server. Run as root from this folder.
# The relay secret (same value as OPS_WATCHDOG_SECRET in Vercel) lives in
# /opt/jarvis-ops/secrets/ops_watchdog_secret; it is generated once here.
set -eu
id jarvisops >/dev/null 2>&1 || useradd --system --home-dir /opt/jarvis-ops --shell /usr/sbin/nologin jarvisops
install -d -o root -g root -m 755 /opt/jarvis-ops /opt/jarvis-ops/bin
install -d -o jarvisops -g jarvisops -m 750 /opt/jarvis-ops/state
install -d -o root -g jarvisops -m 750 /opt/jarvis-ops/secrets
install -o root -g root -m 755 jarvis_watchdog.py /opt/jarvis-ops/bin/jarvis_watchdog.py
install -o root -g root -m 644 jarvis-watchdog.service jarvis-watchdog.timer /etc/systemd/system/
systemctl daemon-reload
SECRET=/opt/jarvis-ops/secrets/ops_watchdog_secret
if [ ! -s "$SECRET" ]; then
  (umask 027; python3 -c "import secrets; print(secrets.token_urlsafe(32))" > "$SECRET")
  echo "generated relay secret $SECRET - copy it into Vercel as OPS_WATCHDOG_SECRET"
fi
chown root:jarvisops "$SECRET"
chmod 640 "$SECRET"
if [ "${ENABLE_TIMER:-0}" = "1" ]; then
  systemctl enable --now jarvis-watchdog.timer
  echo "watchdog timer enabled"
else
  echo "timer not enabled yet: rerun with ENABLE_TIMER=1 once Vercel has OPS_WATCHDOG_SECRET"
fi
