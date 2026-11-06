#!/usr/bin/env bash
# Construit l'application Kopilia : src-tauri/target/release/bundle/macos/Kopilia.app
#
# Elle est signée avec ton certificat « Apple Development » s'il y en a un
# (sinon, signature locale) : macOS lie ses autorisations (micro, Surveillance
# de l'entrée) à la signature, elles tiennent alors d'une version à l'autre.
# Un autre certificat : APPLE_SIGNING_IDENTITY="…" pnpm app
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)"
fi
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
echo "Signature : $APPLE_SIGNING_IDENTITY"

# La boule et la galaxie de la page d'attente : le même dessin que l'écran (apps/web).
pnpm run waiting
pnpm exec tauri build --bundles app "$@"
echo "Prête : $(pwd)/src-tauri/target/release/bundle/macos/Kopilia.app"
