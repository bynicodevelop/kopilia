# Contrats d'événements

Source de vérité : [`packages/contracts/src`](../packages/contracts/src). Validation à l'exécution par **zod** côté serveur (tailles, types, ordre). Version du protocole : **1** (`PROTOCOL_VERSION`).

## Enveloppe (messages de contrôle, JSON texte)

Tous les messages de contrôle portent : `v`, `eventId`, `sessionId`, `ts`, et selon le cas `turnId`, `jobId`, `seq`. Un `eventId` rejoué (reconnexion) n'est traité **qu'une fois** (idempotence) : une transcription finale identifiée ne déclenche qu'un seul tour.

## Navigateur → Serveur

| type | effet |
|---|---|
| `mic.format` | déclare `streamId` + format avant les trames micro ; `bargeIn` : Kopilia parlait (lecture mise en pause), donc si l'énoncé lui demande de se taire, Claude saura qu'il a été coupé ; `ptt` : dit en tenant la touche, la phrase part telle quelle, sans attendre une suite même si elle a l'air inachevée |
| `mic.cancel` | abandonne l'énoncé en cours (`streamId`) : rien n'est transcrit ni envoyé |
| `call.state` | `inCall` : l'écran peut faire parler Kopilia (premier geste dans la page : son autorisé, micro ouvert) ; à ce moment, un brief jamais annoncé est dit en premier. `muted` : Kopilia garde ses prises de parole spontanées (rapports) pour plus tard, et ce qui part sur Telegram page fermée y part aussitôt ; l'écran actuel ne l'envoie plus (on parle à la touche) |
| `page.visibility` | `hidden` : la page est cachée (autre onglet, fenêtre réduite) ou de nouveau visible ; tous les écrans cachés, ce qui part sur Telegram page fermée y part aussi (Kopilia le dit quand même s'il est en appel) |
| `text.input` | saisie de diagnostic (déclenche un tour) |
| `playback.interrupt` | coupure explicite (toucher l'orbe, touche relâchée sans rien dire) : coupe la lecture **et arrête la génération**, y compris les tours en attente derrière elle ; le tour suivant signale l'interruption à Claude. Une nouvelle phrase pendant une réponse n'a le même effet, côté serveur, que si elle commence par un mot d'arrêt (« stop », « attends », « non »… : `cutsReply`) ; sinon la réponse va à son terme et le tour de la phrase la suit (sans phrase d'attente). Côté écran, un énoncé vide (touche relâchée sans parler) coupe Kopilia par ce message. |
| `job.command` | `status` / `cancel` / `instruct` une tâche |
| `approval.resolve` | réponse à une demande sensible |

## Serveur → Navigateur

| type | effet |
|---|---|
| `session.ready` | session prête (+ `claudeSessionId` si connu) |
| `state.changed` | `idle/listening/transcribing/thinking/speaking` (`error` est prévu par le contrat mais jamais émis : une erreur arrive par le message `error`) |
| `transcript.partial` / `transcript.final` | STT en cours / énoncé final ; `cut` : la phrase demande à Kopilia de se taire, le navigateur coupe la voix qu'il joue encore. Sans `cut`, il la laisse finir et garde la réponse de la phrase (messages et trames) pour la jouer et l'afficher ensuite ([`reply-queue.ts`](../apps/web/src/app/call/reply-queue.ts)) ; un `agent.report` attend de la même façon |
| `assistant.delta` / `assistant.done` | texte au fil de l'eau (groupé par phrases pour Kokoro) / fin de tour + issue |
| `audio.start` / `audio.end` | ouverture/fermeture d'un flux de parole (format déclaré) |
| `speech.segment` | repère texte / voix : la phrase `index` du tour, telle qu'écrite (`text`), envoyée juste avant ses trames audio ; `silent` : rien à dire (bloc de code, émoji seul), envoyée tout de suite. Bout à bout, les `text` redonnent les deltas. Le navigateur, en appel, affiche chaque phrase au rythme de sa voix |
| `job.updated` | état vérifié d'un agent ou d'une tâche (`kind` : `agent` / `task`, + consigne en attente) |
| `agent.report` | Kopilia prend la parole de lui‑même pour rapporter un travail terminé (`jobId`, `title`, et `briefId` pour un brief de veille) ; les deltas et l'audio de ce `turnId` suivent. Émis seulement quand aucune réponse n'est en cours et que l'utilisateur ne parle pas. |
| `brief.ready` | un brief de veille est disponible (`briefId`, `title`, `createdAt`, `trigger` : `manual` / `scheduled`) ; texte complet par `GET /api/briefs/:id`, dernier par `GET /api/briefs/latest` |
| `learning.updated` | une relecture ou un rangement est terminé (`runId`, `kind` : `review` / `curator`, `summary` : ce que Kopilia a retenu, `changes` : nombre de changements, `pending` : recettes en attente de l'utilisateur) ; détail par `GET /api/learning` (en-têtes `x-session-id` / `x-session-token`) |
| `dashboard.updated` | le tableau de bord a changé (encart ouvert, réglé ou fermé, tracé ou alerte posé, déplacé ou effacé, à la voix ou à l'écran) : `panels`, tous les encarts dans l'ordre (`id`, `kind` : `chart` / `quotes`, `title` ; graphique : `symbol`, `name`, `digits`, `timeframe`, `indicators` : `{id, kind: ma, type: sma/ema/wma/smma/hma, period, source}` ou `{id, kind: rsi, period, source, overbought, oversold, signal?}`, avec `color?`, `width?`, `hidden?` ; suivi : `symbols`), et `drawings`, les tracés des produits des graphiques affichés (`id` stable, `symbol`, `kind` : `hline` `price` / `trendline` `a`, `b` (`t` instant de bougie en s, `price`), `extend` / `zone` `top`, `bottom`, `from?`, `to?` ; `label?`, `createdBy` : `user` / `kopilia`). Formes et calculs (cinq moyennes, RSI de Wilder, sources, indicateurs gardés à l'ancienne complétés par `upgradeIndicator`, position d'un instant en bougies) dans `packages/contracts/src/technical.ts`, partagés par l'écran et le serveur. Envoyé aussi à la connexion. Bougies par `GET /api/dashboard/candles?symbol&timeframe&before&limit` ; fermer ou régler (unité de temps, `indicators` : la liste entière) par `POST /api/dashboard/panels/:id[/close]`, `POST /api/dashboard/close-all` ; tracer, déplacer, effacer par `POST /api/dashboard/drawings` (`symbol`, `shape`), `POST /api/dashboard/drawings/:id` (`shape`, `label`), `POST /api/dashboard/drawings/:id/delete` (en-têtes de session). `alerts` : les alertes des produits des graphiques affichés (`id` stable `a_…`, `symbol`, `name`, `digits?`, `target` : `{kind: price, price}` / `{kind: drawing, drawingId}`, `condition` : `cross` / `up` / `down`, `trigger` : `once` / `bar` / `close`, `timeframe`, `message?` (consigne pour Kopilia), `state` : `active` / `paused` / `triggered` / `expired`, `createdBy`, `createdAt`, `updatedAt` (dernier armement), `triggeredAt?`, `triggeredPrice?`), schéma dans `packages/contracts/src/alerts.ts` ; poser, régler (prix, réglages, `state` : `active` / `paused`), retirer par `POST /api/dashboard/alerts` (`symbol`, `target`, `condition`, `trigger`, `timeframe`, `message`), `POST /api/dashboard/alerts/:id`, `POST /api/dashboard/alerts/:id/delete` |
| `alert.triggered` | une alerte vient de partir (`alertId`, `symbol`, `title` : « Or : ligne « résistance » franchie à la hausse », `detail` : « 3 950,40 à 14:32:05 · niveau 3 950,00 », `direction` : `up` / `down`, `price`, `at` epoch ms) : bandeau, son, notification si la page est cachée, ligne qui clignote. En appel, un `agent.report` « Alerte · … » suit (Kopilia l'annonce et suit la consigne) |
| `market.quote` | cotation en direct d'un produit affiché (`symbol`, `bid`, `ask`, `time` epoch ms, `digits`, `dayOpen` : ouverture de la journée du courtier), tant qu'un écran est connecté et qu'un encart le montre ; les dernières connues sont renvoyées à la connexion |
| `approval.required` | action exacte + projet + expiration |
| `error` | code, message, action de reprise |

## Trames binaires (audio)

En‑tête compact **16 octets** puis charge PCM `s16le` — voir [`audio.ts`](../packages/contracts/src/audio.ts) :

```
offset 0  magic 'KP' (0x4B50, u16 LE)
offset 2  version (u8 = 1)
offset 3  kind (u8 : 0=micro, 1=parole)
offset 4  streamId (u32 LE)
offset 8  seq (u32 LE)
offset 12 flags (u8 : bit0 = dernière trame)
offset 13 réservé
offset 16 PCM16LE…
```

- **Micro** (navigateur → serveur) : 16 kHz mono 16 bits (requis par whisper.cpp).
- **Parole** (serveur → navigateur) : fréquence **déclarée** par Kokoro dans `audio.start` (24 kHz).
- Les trames périmées (après barge‑in) sont ignorées : la génération est invalidée côté serveur et la lecture purgée côté navigateur.

## Protocole des workers (stdio NDJSON)

- **STT** : `stt.open/audio/close/cancel` → `stt.ready/vad/partial/final/error` — voir [`workers.ts`](../packages/contracts/src/workers.ts).
- **TTS** : `tts.speak/cancel` → `tts.ready/start/chunk/end/error`.
- Doubles déterministes : [`workers/_doubles`](../workers/_doubles) (utilisés par les tests et la recette hors modèles).

## CLI Claude (stream-json)

Entrée (une ligne par tour) : `{"type":"user","message":{"role":"user","content":"…"}}`.
Interruption : `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}` (protocole de contrôle du CLI, celui de l'Agent SDK) ; le tour se termine alors par un `result`.
Sortie lue : `system/init` (porte `session_id`), `stream_event` (deltas de texte — **source unique** pour éviter la double lecture), repli `assistant` si pas de flux partiel, `result` (fin + `is_error`). Voir [`claude.ts`](../packages/contracts/src/claude.ts) et [`claude-process.ts`](../apps/server/src/session/claude-process.ts). La trace réelle de la version installée se capture avec `node scripts/record-claude-events.mjs`.
