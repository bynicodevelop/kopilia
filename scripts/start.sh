#!/usr/bin/env bash
# Démarrage quotidien en une commande. Construit si nécessaire puis lance le
# serveur (qui sert aussi l'interface Angular). PID consigné dans run/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p run logs

if [ ! -f apps/server/dist/main.js ] || [ ! -f apps/web/dist/kopilia-web/browser/index.html ]; then
  echo "Build manquant — compilation…"
  pnpm run build
fi

PORT="${KOPILIA_PORT:-4317}"
HOST="${KOPILIA_HOST:-127.0.0.1}"
if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "Un service écoute déjà sur $PORT. 'pnpm stop' d'abord, ou changez KOPILIA_PORT."
  exit 1
fi

echo "Démarrage de Kopilia sur http://$HOST:$PORT"
node apps/server/dist/main.js &
echo $! > run/kopilia.pid
echo "PID $(cat run/kopilia.pid). Ouvrez http://$HOST:$PORT  (Ctrl+C ou 'pnpm stop' pour arrêter)"
wait "$(cat run/kopilia.pid)"
