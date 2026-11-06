#!/usr/bin/env bash
# Bootstrap Kopilia — relançable et idempotent.
# Détecte l'outillage, installe les dépendances, compile les moteurs vocaux,
# télécharge les modèles, synthétise une phrase de contrôle, puis lance doctor.
#
# Préférence : installations dans le compte utilisateur. Aucun secret affiché.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "== Installation de Kopilia =="
echo "Dépôt : $ROOT"

step() { printf "\n\033[1m• %s\033[0m\n" "$1"; }

# --- 1. Détection de l'environnement ---
step "Détection de l'environnement"
ARCH="$(uname -m)"; OS="$(sw_vers -productVersion 2>/dev/null || echo '?')"
echo "arch=$ARCH macOS=$OS node=$(node -v 2>/dev/null || echo absent) pnpm=$(pnpm -v 2>/dev/null || echo absent) python3=$(python3 --version 2>/dev/null || echo absent)"
[ "$ARCH" = "arm64" ] || echo "AVERTISSEMENT : moteurs vocaux optimisés pour Apple Silicon (arm64)."
command -v node >/dev/null || { echo "Node 22+ requis. Installez-le (https://nodejs.org) puis relancez."; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm requis : 'corepack enable && corepack prepare pnpm@latest --activate'"; exit 1; }
# Kokoro (la voix) demande Python 3.10 à 3.12 : le python3 de macOS (3.9) et celui de Homebrew (3.13+) ne conviennent pas.
PY=""
for c in python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 12) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Python 3.12 requis pour la voix (Kokoro ne s'installe pas avec 3.13 ou plus) : brew install python@3.12, puis relancez."; exit 1; }
echo "Python pour la voix : $PY ($("$PY" --version 2>&1))"
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Outils de compilation Apple manquants. Exécutez : xcode-select --install (dialogue système), puis relancez."
  exit 1
fi

# --- 2. Dépendances JS + build ---
step "Installation des dépendances (pnpm)"
pnpm install

step "Build (contracts, serveur, web)"
pnpm run build

# --- 3. whisper.cpp (Metal) ---
step "Compilation de whisper.cpp (Metal)"
bash scripts/build-whisper.sh

# --- 4. Environnement Python Kokoro ---
step "Environnement Python Kokoro"
# Phonémisation française : espeak-ng (dépendance système de misaki[fr]).
if ! command -v espeak-ng >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installation d'espeak-ng (phonémisation FR)…"; brew install espeak-ng || echo "AVERTISSEMENT : installez espeak-ng manuellement."
  else
    echo "AVERTISSEMENT : espeak-ng requis pour la phonémisation française (brew install espeak-ng)."
  fi
fi
if [ ! -x workers/kokoro/.venv/bin/python ]; then
  "$PY" -m venv workers/kokoro/.venv
fi
workers/kokoro/.venv/bin/python -m pip install --upgrade pip >/dev/null
workers/kokoro/.venv/bin/python -m pip install -r workers/kokoro/requirements.txt

# --- 5. Modèles STT ---
step "Téléchargement des modèles Whisper"
node scripts/fetch-models.mjs

# --- 6. Préchauffage Kokoro (évite un chargement implicite au 1er lancement) ---
step "Synthèse de contrôle Kokoro (voix ff_siwis)"
workers/kokoro/.venv/bin/python workers/kokoro/warmup.py || {
  echo "AVERTISSEMENT : préchauffage Kokoro incomplet (réseau ?). Relancez après connexion."; }

# --- 7. CLI Claude ---
step "Vérification du CLI Claude"
if ! claude --version >/dev/null 2>&1; then
  echo "CLI Claude introuvable. Installez-le (curl -fsSL https://claude.ai/install.sh | bash), puis lancez claude pour vous connecter (abonnement Pro, Max ou Ultra)."
else
  claude --version
  echo "Si doctor signale l'authentification : exécutez 'claude login'."
fi

# --- 8. Config ---
step "Configuration"
[ -f .env ] || { cp .env.example .env; echo ".env créé depuis .env.example (mettez-y votre jeton MetaApi : voir le README)."; }
[ -f config/vocabulaire.txt ] || { cp config/vocabulaire.example.txt config/vocabulaire.txt; echo "config/vocabulaire.txt créé : vos mots pour la reconnaissance vocale."; }

# --- 9. Diagnostic final ---
step "Diagnostic"
node scripts/doctor.mjs || true

echo -e "\n\033[1mBootstrap terminé.\033[0m Démarrage quotidien : \033[1mpnpm start\033[0m"
