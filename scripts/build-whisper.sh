#!/usr/bin/env bash
# Compile whisper.cpp avec accélération Metal et expose les binaires dans
# workers/whisper/bin/. Idempotent : ne recompile pas si à jour.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VENDOR="$ROOT/vendor/whisper.cpp"
BIN="$ROOT/workers/whisper/bin"
REV="${WHISPER_CPP_REV:-v1.7.4}"

mkdir -p "$BIN"
# whisper-server garde le modèle en mémoire (une phrase = une requête locale) ;
# whisper-cli sert de repli. Un build existant qui n'expose pas encore le
# serveur est simplement complété.
if [ ! -x "$BIN/whisper-server" ] && [ -x "$VENDOR/build/bin/whisper-server" ]; then
  cp "$VENDOR/build/bin/whisper-server" "$BIN/whisper-server"
fi
if [ -x "$BIN/whisper-cli" ] && [ -x "$BIN/whisper-server" ] && [ "${FORCE_WHISPER:-0}" != "1" ]; then
  echo "whisper-cli et whisper-server déjà présents ($BIN). FORCE_WHISPER=1 pour recompiler."
  exit 0
fi

if [ ! -d "$VENDOR/.git" ]; then
  echo "Clonage de whisper.cpp ($REV)…"
  git clone --depth 1 --branch "$REV" https://github.com/ggml-org/whisper.cpp "$VENDOR" 2>/dev/null \
    || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$VENDOR"
fi

echo "Compilation (Metal activé par défaut sur Apple Silicon)…"
cmake -S "$VENDOR" -B "$VENDOR/build" -DGGML_METAL=1 -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$VENDOR/build" -j --config Release

# Copie des binaires utiles (noms selon version : whisper-cli / main).
for cand in whisper-cli main; do
  found="$(find "$VENDOR/build" -name "$cand" -type f -perm -111 2>/dev/null | head -1 || true)"
  [ -n "$found" ] && cp "$found" "$BIN/whisper-cli" && break
done
[ -x "$BIN/whisper-cli" ] || { echo "Échec : binaire whisper introuvable après build."; exit 1; }
found="$(find "$VENDOR/build" -name whisper-server -type f -perm -111 2>/dev/null | head -1 || true)"
[ -n "$found" ] && cp "$found" "$BIN/whisper-server"
echo "OK : $BIN/whisper-cli${found:+ + whisper-server}"
