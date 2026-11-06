# Kopilia

**Ton copilote de trading à la voix, en français, sur ton Mac.**

Tu maintiens une touche, tu parles, Kopilia te répond à voix haute : il ouvre tes graphiques, trace tes niveaux, surveille tes alertes, te fait le point macro, discute ton analyse et tient ton journal de trading. La voix et sa transcription restent sur ton Mac ; l'intelligence vient de **Claude**, avec ton propre abonnement.

- **Parle-lui comme à un collègue** : maintiens **⌥ droite**, parle, lâche. Ça marche même avec TradingView devant, grâce à l'application Mac.
- **Tes cours en direct** : graphiques de ton courtier (via MetaApi), moyennes mobiles, RSI, tracés, alertes surveillées même page fermée.
- **Le marché résumé** : un point macro le matin et à midi, le calendrier économique, les news importantes traduites et dites au moment où elles tombent.
- **Un contradicteur** : il note ton analyse d'un produit, te rappelle ce que tu disais hier et te pose la bonne objection.
- **Des setups selon ta façon de trader** : il les cherche sur tes produits et tes unités de temps, et te prévient quand l'un se met en place.
- **Prise de position** : boîte de trade, taille calculée selon ton risque, ordre préparé et envoyé **seulement sur ta confirmation** (coupé par défaut, compte de démo seulement).
- **Journal de trading** : chaque trade avec son graphique, tes notes dictées, tes bilans du jour, de la semaine et du mois.
- **Quand tu t'absentes** : tes alertes partent sur Telegram, graphique compris.

> Kopilia est un outil d'analyse personnel. **Ce n'est pas un conseil en investissement.** Le trading de CFD et de produits à effet de levier comporte un risque élevé de perte en capital.

---

## 1. Ce qu'il te faut

| | Quoi | Pourquoi |
|---|---|---|
| **Indispensable** | Un **Mac Apple Silicon** (M1 ou plus récent) et environ **4 Go** d'espace libre | La voix et la transcription tournent sur le Mac |
| **Indispensable** | Un abonnement **Claude** qui inclut **Claude Code** : Pro, Max ou Ultra ([voir les offres](https://claude.com/pricing)) | C'est le cerveau de Kopilia. L'offre gratuite ne suffit pas |
| **Indispensable** | Un compte **[MetaApi](https://app.metaapi.cloud/sign-up)** relié à ton compte **MetaTrader 4 ou 5** ([tarifs](https://metaapi.cloud/#pricing)) | Les cours, les graphiques et, si tu le veux, les ordres |
| Conseillé | Un casque ou des écouteurs | Pour que Kopilia ne s'entende pas lui-même |
| Facultatif | Un bot **Telegram** | Recevoir tes alertes quand tu n'es pas devant le Mac |

**Testé sur** : Mac M3 Pro, macOS 27, Claude Ultra, compte de démo MetaTrader.

Les outils de développement (Node, pnpm, Python, Homebrew…) s'installent pendant l'installation : le plus simple est de laisser Claude s'en charger (section 2).

---

## 2. Installation avec Claude (conseillé)

**a. Installe Claude Code.** Ouvre le Terminal (⌘ Espace, tape « Terminal ») et colle :

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Ouvre ensuite une nouvelle fenêtre du Terminal et tape `claude` : il ouvre ton navigateur pour te connecter à ton compte Claude. Une fois connecté, quitte-le (`/exit`). Documentation officielle : [code.claude.com](https://code.claude.com/docs/en/setup).

**b. Télécharge Kopilia** dans ton dossier Documents :

```bash
cd ~/Documents && git clone https://github.com/bynicodevelop/kopilia.git Kopilia && cd Kopilia
```

(Si macOS te propose d'installer les outils de développement pour `git`, accepte, puis relance la commande.)

**c. Lance Claude dans le dossier de Kopilia** :

```bash
claude
```

**d. Colle ce message** et laisse-toi guider :

```text
Installe et démarre Kopilia sur ce Mac. Tu es dans le dossier du dépôt ; lis le README.md avant de commencer.
Explique-moi chaque étape simplement : je ne suis pas forcément développeur.

1. Vérifie les prérequis et installe ce qui manque :
   - un Mac Apple Silicon (arm64) ;
   - les outils de compilation Apple (xcode-select -p) ; s'ils manquent, lance xcode-select --install et attends que je valide la fenêtre ;
   - Homebrew ; s'il manque, donne-moi la commande officielle de brew.sh à lancer moi-même, car elle demande mon mot de passe ;
   - Node 22 (brew install node@22, puis ajoute-le au PATH de mon shell) et pnpm (npm install -g pnpm@10) ;
   - Python 3.12 (brew install python@3.12) : la voix ne s'installe pas avec Python 3.13 ou plus ;
   - espeak-ng (brew install espeak-ng).
2. Lance pnpm run setup (avec « run ») et suis-le jusqu'au bout. Il compile la transcription, installe la voix et
   télécharge les modèles (près de 1 Go) : c'est long, laisse-le finir. S'il s'arrête, lis le message, corrige, relance :
   il reprend là où il en était.
3. Configuration minimale dans le fichier .env (créé par le setup) :
   - guide-moi pour créer mon compte MetaApi et y ajouter mon compte MetaTrader (section 4 du README) ;
   - ne me demande jamais mon jeton MetaApi dans la conversation : dis-moi d'ouvrir .env et de le coller moi-même
     dans KOPILIA_METAAPI_TOKEN, puis l'identifiant du compte dans KOPILIA_METAAPI_ACCOUNT_ID ;
   - demande-moi quels produits je trade et mets-les dans KOPILIA_SETUP_PRODUCTS ;
   - laisse KOPILIA_TRADING_ORDERS=0 : je l'activerai moi-même plus tard si je le veux.
4. Lance pnpm doctor et corrige ce qui ne va pas.
5. Démarre Kopilia avec pnpm start, ouvre http://127.0.0.1:4317 dans mon navigateur, et explique-moi comment lui parler.

Ne modifie aucun fichier du dépôt en dehors de .env, et ne lance rien avec sudo sans me le demander.
```

Compte 20 à 40 minutes, surtout pour la compilation et les téléchargements.

---

## 3. Installation à la main

Pour ceux qui préfèrent taper les commandes eux-mêmes.

```bash
# Outils de compilation Apple (une fenêtre s'ouvre : accepte)
xcode-select --install

# Homebrew : suis les instructions de https://brew.sh, puis :
brew install node@22 python@3.12 espeak-ng
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
npm install -g pnpm@10

# Claude Code, puis connexion à ton compte (tape /exit une fois connecté)
curl -fsSL https://claude.ai/install.sh | bash
claude

# Kopilia
cd ~/Documents && git clone https://github.com/bynicodevelop/kopilia.git Kopilia && cd Kopilia
pnpm run setup
```

> Tape bien `pnpm run setup`, avec `run` : `pnpm setup` tout court est une autre commande, propre à pnpm.

`pnpm run setup` installe les dépendances, compile la transcription (whisper.cpp), installe la voix (Kokoro), télécharge les modèles, crée ton fichier `.env` et termine par un diagnostic. Il peut être relancé autant de fois qu'il le faut.

---

## 4. Configuration minimale

Tout se règle dans le fichier **`.env`**, à la racine du dossier (il est caché dans le Finder : ⌘ Maj . pour l'afficher). Il ne quitte jamais ton Mac et n'est jamais envoyé sur GitHub. Trois choses suffisent pour commencer.

### MetaApi (les cours de ton courtier)

1. Crée ton compte sur [app.metaapi.cloud](https://app.metaapi.cloud/sign-up).
2. Ajoute ton compte **MetaTrader 4 ou 5** : son numéro (login), son mot de passe et le nom du serveur de ton courtier, tels qu'ils s'affichent dans MetaTrader.
   - Le **mot de passe investisseur** suffit pour les cours et les graphiques : lecture seule, aucun ordre possible.
   - Le mot de passe principal n'est utile que si tu veux que Kopilia prépare des ordres. Commence par un **compte de démo**.
3. Vérifie que le compte est **déployé** (« deployed ») dans MetaApi.
4. Copie ton **jeton d'API** et l'**identifiant du compte** dans `.env` :

```bash
KOPILIA_METAAPI_TOKEN=colle-ici-ton-jeton
KOPILIA_METAAPI_ACCOUNT_ID=colle-ici-l-identifiant-du-compte
```

### Tes produits

Les produits que tu trades, avec leur nom courant ou leur symbole : Kopilia retrouve tout seul le symbole de ton courtier (NAS100, US100, USTEC…).

```bash
KOPILIA_SETUP_PRODUCTS=Nasdaq,Dow Jones,or,EURUSD
```

### Vérifier

```bash
pnpm doctor
```

Ce qui est en rouge dit quoi corriger. La ligne « MetaApi » confirme que ton compte répond.

Le reste est facultatif et expliqué dans [`.env.example`](.env.example) : Telegram, les ordres, les modèles de Claude, les heures des points macro…

---

## 5. Démarrer et parler à Kopilia

```bash
pnpm start
```

Ouvre **http://127.0.0.1:4317**. Clique une fois dans la page pour autoriser le son et le micro, puis :

- **maintiens ⌥ droite** (la touche Option à droite de la barre d'espace), parle, et **lâche** pour envoyer ;
- un **appui bref** sur ⌥ droite le fait taire ; commencer ta phrase par « stop » ou « attends » le coupe aussi ;
- essaie : « Montre-moi le Nasdaq en 15 minutes », « Fais-moi le point macro », « Préviens-moi si l'or casse ma résistance ».

Pour l'arrêter : `pnpm stop`.

### L'application Mac (facultatif)

Dans le navigateur, ⌥ droite ne marche que quand la page de Kopilia est devant. L'application Mac l'entend **partout**, même avec TradingView au premier plan, et démarre Kopilia toute seule. Elle demande [Rust](https://rustup.rs) et Xcode :

```bash
pnpm app
```

Au premier lancement, macOS demande l'accès au micro, puis à « Surveillance de l'entrée » (Réglages Système › Confidentialité et sécurité) : active Kopilia, puis rouvre l'application.

---

## 6. Bon à savoir

- **Ton abonnement Claude travaille aussi en fond.** En plus de la conversation, Kopilia lance des tâches de fond : points macro, recherche de setups, apprentissage. Avec une offre Pro, tu peux atteindre tes limites plus vite. Pour alléger : `KOPILIA_SETUPS=0` (pas de recherche de setups) et `KOPILIA_LEARNING=0` (pas d'apprentissage).
- **Aucun ordre sans toi.** Les ordres sont coupés par défaut (`KOPILIA_TRADING_ORDERS=0`). Même activés, rien ne part sans ta confirmation (« je confirme » ou le bouton du ticket), et seulement sur un compte de démo tant que `KOPILIA_TRADING_LIVE=0`.
- **Tes données restent chez toi.** Le son n'est jamais enregistré. La base, les documents et le journal sont dans `data/`, sur ton Mac. `pnpm data:wipe` efface tout. Le texte de tes échanges, et les documents que tu lui confies, partent chez Claude ; tes cours viennent de MetaApi.
- **Un mot mal compris ?** Ajoute-le dans `config/vocabulaire.txt`, un terme par ligne. C'est ton fichier : l'installation le crée à partir du [modèle](config/vocabulaire.example.txt), et il reste sur ton Mac. C'est pris en compte en 30 secondes.

| Commande | Rôle |
|---|---|
| `pnpm run setup` | installer ou réparer |
| `pnpm doctor` | diagnostic |
| `pnpm start` / `pnpm stop` | démarrer / arrêter |
| `pnpm app` | construire l'application Mac |
| `pnpm data:wipe` | effacer les données de Kopilia |

---

## 7. Pour aller plus loin

- [Le guide détaillé](docs/GUIDE.md) : chaque fonction, tous les réglages, l'architecture.
- [L'apprentissage de Kopilia](docs/APPRENTISSAGE.md) : comment il retient ta façon de travailler.
- [Les sources techniques](docs/RECIPE.md) : modèles de voix et de transcription, Claude Code, MetaApi.

## Licence

Code source ouvert sous licence **Apache 2.0 avec la Commons Clause** ([LICENSE](LICENSE)) : tu peux l'utiliser, y compris pour ton propre trading, le modifier et le partager, mais pas le vendre, ni vendre un service (hébergement, installation, accompagnement) dont la valeur vient surtout de lui. Ce n'est donc pas une licence « open source » au sens de l'OSI.
