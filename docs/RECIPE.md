# Rapport de recette — Kopilia

> **Instantané historique** de la recette initiale. Certaines limites décrites ici ont été levées depuis (l'authentification `claude -p` fonctionne, la transcription passe par `whisper-server`, modèle gardé en mémoire). L'état à jour est dans le [README](../README.md) ; la suite de tests (`pnpm test`) fait foi.

Date de la base : **2026‑11‑02**. Machine de construction : Mac Apple Silicon, macOS 27.0.1, 18 Go RAM, Node 22.23, pnpm 10.11, Python 3.12, clang 21, cmake 4, CLI Claude 2.1.131.

**Trois natures de preuve** sont distinguées ci‑dessous :
- 🟢 **Simulé (vérifié ici)** : test automatisé passé sur cette machine avec doubles déterministes.
- 🟡 **Réel machine (à exécuter chez vous)** : nécessite modèles compilés/téléchargés et/ou CLI authentifié.
- 🔇 **Écoute humaine (à faire)** : qualité audio perçue, interruption réelle au micro.

> **Limite connue de l'environnement de construction.** Dans le sandbox Claude Code où cette base a été bâtie, **tout** appel `claude -p` renvoie `401 OAuth access token is invalid` (vérifié aussi hors de tout code). Le pipeline (spawn, capture `session_id`, deltas en flux, `result`/issue) fonctionne parfaitement ; seule l'authentification finale manque **ici**. Sur **votre** Mac, après `claude login` (abonnement Claude Max), la boucle réelle fonctionne. La boucle a donc été **entièrement vérifiée** avec un double déterministe du CLI, y compris le rappel « Atlas ».

## Résultats par étape de livraison (§8)

| Étape | Preuve obtenue | Reste à faire |
|---|---|---|
| **1. Bootstrap & diagnostic** | 🟢 `doctor` fonctionne (11/16 OK ici ; signale justement modèles/venv/auth). Scripts relançables écrits. | 🟡 `pnpm run setup` complet (compile whisper.cpp, venv Kokoro, télécharge modèles) sur votre Mac. |
| **2. Boucle texte Nest ↔ Claude** | 🟢 Rappel « Atlas » sur **deux tours** vérifié de deux façons : (a) test e2e serveur avec double CLI, (b) **dans l'interface Angular réelle** via le navigateur. Deltas partiels + fin détectés. Session `claude` persistée (reprise `--resume` câblée). | 🟡 Relancer les deux tours avec le **vrai** CLI authentifié ; confirmer le rappel après redémarrage de Nest. |
| **3. Audio local séparé** | 🟢 Protocole STT/TTS vérifié avec doubles (transcript.final, audio PCM). Workers réels écrits (whisper‑cli batch ; Kokoro ff_siwis). | 🟡 Transcrire un enregistrement FR réel, synthétiser en ff_siwis, réussir **hors ligne** après setup. 🔇 Écoute. |
| **4. Conversation réelle** | 🟢 Chaîne micro→STT→tour→TTS→audio vérifiée (double) : trames micro → `transcript.final` → tour ; `audio.start`/trames PCM/`audio.end`. **Barge‑in** vérifié. Pas d'auto‑transcription du silence (worker ne finalise que sur énoncé). | 🟡🔇 Deux questions au micro, deux réponses FR, couper la 2ᵉ en parlant (haut‑parleurs puis casque). |
| **5. Travail concurrent** | 🟢 `JobService` : un job actif max, worker en groupe de processus (annulation = kill du groupe), `job.updated` relayé, consigne en attente. Serveur MCP de coordination + API interne loopback écrits et compilés. | 🟡 Lancer une tâche lente dans un dépôt jetable, demander l'état **à la voix**, vérifier l'unicité et le résumé. |
| **6. Résilience & contrôle** | 🟢 Idempotence (eventId rejoué = 1 tour) vérifiée ; env assaini vérifié ; relance bornée des workers ; erreurs avec action de reprise. Micro refusé → message exploitable (UI). | 🟡 Quota simulé, coupure WS, redémarrage serveur, refus d'action, annulation — à rejouer bout en bout. |
| **7. Livraison** | 🟢 `build`, `test`, `doctor` fonctionnent ; commandes fournies ; ce rapport. | 🟡 Rapport de **mesures** (latences) sur votre Mac (§ ci‑dessous). |

### Tests automatisés (🟢, `pnpm test`)
`packages/contracts` (5) : trame binaire aller‑retour, magie invalide, parsing messages. `apps/server` (10) : **rappel Atlas 2 tours**, synthèse (audio.start/PCM/audio.end), entrée vocale (micro→final→tour), **barge‑in**, **idempotence**, assainisseur d'environnement, mémoire FTS5 + isolation projets + remplacement/oubli. Protocole exercé avec trames binaires et doubles de workers.

### À étendre (honnêteté)
Fuzz de protocole plus poussé (trames fragmentées arbitraires, messages dupliqués massifs, sortie brutale de process, audio obsolète sous charge) : amorcé via les doubles, à compléter. STT **streaming** basse latence (actuellement par énoncé). Monitoring économique, rôles/compétences, MetaApi (§10‑13 du CDC) : schéma SQLite et emplacements prévus, adaptateurs à implémenter.

## Plan de mesures (§7) — à remplir sur votre Mac

Horodater : fin de parole → texte définitif → 1er delta Claude → 1ʳᵉ phrase synthétisée → 1ᵉʳ échantillon joué. Publier médianes et valeurs hautes sur 10 échanges, à chaud et à froid ; mémoire par processus ; charge au repos et en parole. **Séparer** le délai réseau de Claude de celui des moteurs locaux. Cible : interruption locale **< 250 ms** après détection. Mesurer avant tout changement de modèle (Tiny) ou de voix.

## Comportement dégradé
Perte réseau → texte dicté conservé + renvoi explicite. Panne TTS → réponse affichée. Panne STT → saisie clavier. Worker tombé → relance bornée + vérification d'état. Files et délais bornés ; saturation affichée ; pas de boucle de relance. Micro inactif ne transcrit pas le silence en continu.

## Reprise en cas d'échec (symptôme → commande)
- Auth CLI (`401`) → `claude login` puis `pnpm doctor`.
- Modèles absents → `pnpm models:fetch` (reprise sans re‑téléchargement).
- whisper‑cli absent → `bash scripts/build-whisper.sh`.
- Kokoro muet → vérifier `espeak-ng` (`brew install espeak-ng`) et `workers/kokoro/.venv`.
- Port occupé → `pnpm stop` ou changer `KOPILIA_PORT`.
- Trace événements CLI → `node scripts/record-claude-events.mjs` → `docs/claude-events-sample.ndjson`.

## Références primaires
- whisper.cpp — modèles, mémoire, Metal, VAD : https://github.com/ggml-org/whisper.cpp
- Kokoro — implémentation : https://github.com/hexgrad/kokoro · poids/voix : https://huggingface.co/hexgrad/Kokoro-82M
- Extrait français Siwis : https://huggingface.co/litert-community/Kokoro-82M#samples
- CLI Claude Code : https://code.claude.com/docs/en/cli-reference
- Auth `claude -p` par abonnement : https://support.claude.com/fr/articles/15036540
- MetaApi — compte investisseur : https://metaapi.cloud/docs/provisioning/api/account/createAccount/ · bougies : https://metaapi.cloud/docs/client/restApi/api/retrieveMarketData/readHistoricalCandles/
