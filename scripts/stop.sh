#!/usr/bin/env bash
# Arrêt propre du serveur (et de ses processus enfants : workers, sessions).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${KOPILIA_PORT:-4317}"

# run/jarvis.pid : un serveur lancé avant le nom Kopilia.
for PIDFILE in run/kopilia.pid run/jarvis.pid; do
  [ -f "$PIDFILE" ] || continue
  PID="$(cat "$PIDFILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Arrêt du serveur (PID $PID)…"
    kill -TERM "$PID" 2>/dev/null || true
    sleep 1
    kill -0 "$PID" 2>/dev/null && kill -KILL "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
done
# Filet de sécurité : tout process restant sur le port.
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  lsof -ti "tcp:$PORT" | xargs kill 2>/dev/null || true
fi
echo "Arrêté."
