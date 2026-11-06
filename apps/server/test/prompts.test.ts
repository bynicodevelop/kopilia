import { test } from "node:test";
import assert from "node:assert/strict";
import { setupPassPrompt, setupSystemPrompt } from "../src/setups/setup-prompts.js";
import {
  learningReportPrompt,
  agentReportPrompt,
  agentSystemPrompt,
  briefReportPrompt,
  briefTaskPrompt,
  dialogueSystemPrompt,
  DIRECT_REPORT_MAX_WORDS,
  veilleSystemPrompt,
} from "../src/session/prompts.js";

const NOW = new Date(2026, 10, 2, 13, 0);

test("dialogue : date du jour et souvenirs de l'utilisateur", () => {
  const p = dialogueSystemPrompt(["Habite à Annecy (74000).", "Aime le cinéma d'auteur"], NOW);
  assert.match(p, /Nous sommes le lundi 2 novembre 2026\./);
  assert.match(p, /Ce que tu sais de l'utilisateur : Habite à Annecy \(74000\) ; Aime le cinéma d'auteur\./);
});

test("dialogue : autonomie et délégation (jamais de demande de permission pour chercher)", () => {
  const p = dialogueSystemPrompt([], NOW);
  assert.match(p, /ne demandes JAMAIS la permission/);
  assert.match(p, /ask_agent/);
  assert.match(p, /ne sais encore rien de durable/);
  assert.match(p, /Plusieurs tâches peuvent avancer en même temps dans des projets différents/);
  assert.match(p, /passe le jobId de celui dont parle l'utilisateur/);
});

test("dialogue : cours en direct par MetaApi seulement s'il est configuré", () => {
  const p = dialogueSystemPrompt([], NOW, { marketPrices: true });
  assert.match(p, /utilise tes outils de cours sans demander, plutôt qu'une recherche web/);
  assert.match(p, /market_history donne l'ouverture, le plus haut, le plus bas, la clôture/);
  assert.match(p, /l'ouverture de Wall Street, c'est new_york/);
  assert.match(p, /jamais le symbole du courtier/);
  assert.match(p, /le prix exact tel que l'outil le renvoie, avec toutes ses décimales.*n'arrondis jamais/);
  assert.match(p, /l'heure de la cotation à la seconde/);
  assert.match(p, /Ne lui demande jamais d'appeler MetaApi lui-même ni de lancer des commandes/);
  // Le tableau de bord (encarts) va avec les cours : graphique, suivi, fermer un ou tout, à la voix.
  assert.match(p, /panel_open affiche le graphique en bougies d'un produit \(symbol ; timeframe parmi 1m, 5m, 15m, 30m, 1h, 4h, 1d/);
  assert.match(p, /panel_close ferme un encart, ou tous \(all\)/);
  assert.match(p, /« efface le tableau de bord » : fais-le sans demander/);
  assert.match(p, /\[Encarts à l'écran : …\] qui les liste avec leur identifiant : ce n'est pas lui qui parle/);
  assert.doesNotMatch(dialogueSystemPrompt([], NOW), /market_price|panel_open/);
  assert.doesNotMatch(dialogueSystemPrompt([], NOW), / {2}/, "pas de double espace à la place de la phrase absente");
});

test("dialogue : partenaire de trading, un avis franc sans formule de refus ; les garde-fous des ordres et du public tiennent", () => {
  const p = dialogueSystemPrompt([], NOW, { marketPrices: true, setups: true, telegram: { publics: ["business"] }, x: true });
  assert.match(p, /Tu es aussi son partenaire de trading : un trader expérimenté assis à côté de lui/);
  assert.match(p, /tranche : en deux ou trois phrases, ce qui soutient l'idée, ce qui la fragilise, puis ton verdict/);
  assert.match(p, /Jamais de formule de refus ou de précaution/);
  assert.match(p, /Sois proactif/);
  // Les garde-fous : pas d'ordre de sa propre initiative, sa confirmation, jamais son pourcentage de risque.
  assert.match(p, /tu ne prépares jamais un ordre de ta propre initiative et un ordre ne part que sur sa confirmation/);
  assert.match(p, /tu ne le choisis ni ne le conseilles jamais, pas même dans ton avis ni sous condition/);
  assert.match(p, /tu ne choisis ni ne conseilles jamais un pourcentage/);
  assert.match(p, /tu ne peux pas le confirmer toi-même/);
  // Ce qui est publié reste une analyse.
  assert.match(p, /Ce que tu rédiges pour un canal public est public : une analyse .*jamais un conseil ni un ordre/);
  assert.match(p, /Ce que tu rédiges pour X est public : une analyse, jamais un conseil ni un ordre/);
  // Plus rien qui interdise l'avis dans la conversation privée.
  for (const gone of [
    /tu ne conseilles pas de prendre la position/,
    /Tu ne juges pas ses trades/,
    /la décision reste la sienne/,
    /ce qu'il doit faire de son argent/,
    /sans conseil/,
  ]) {
    assert.doesNotMatch(p, gone);
  }
  assert.doesNotMatch(dialogueSystemPrompt([], NOW), /partenaire de trading/, "sans cours, pas de trading");
});

test("dialogue : connaît les heures des wraps automatiques", () => {
  assert.match(
    dialogueSystemPrompt([], NOW, { briefTimes: ["7 h", "12 h 30"] }),
    /Un wrap est aussi préparé automatiquement du lundi au vendredi à 7 h et 12 h 30\./,
  );
  assert.match(dialogueSystemPrompt([], NOW, { briefTimes: ["7 h"] }), /du lundi au vendredi à 7 h\./);
  assert.match(dialogueSystemPrompt([], NOW), /Il n'y a pas de brief automatique programmé\./);
});

test("dialogue : documents joints lus avec la phrase, les longs confiés à un agent", () => {
  const p = dialogueSystemPrompt([], NOW);
  assert.match(p, /\[Document joint : …\]/);
  assert.match(p, /sa phrase dit quoi en faire/);
  assert.match(p, /ask_agent en passant son identifiant dans documents/);
  assert.match(p, /trop long pour toi n'arrive que sous forme de note : confie-le à un agent/);
});

test("agent : lecture seule, persévérance, réponse finale exploitable à l'oral", () => {
  const p = agentSystemPrompt(["Habite à Annecy (74000)."], NOW);
  assert.match(p, /Tu ne modifies rien/);
  assert.match(p, /Habite à Annecy/);
  assert.match(p, /ne pose aucune question/);
});

test("rapport d'agent : statut lisible et résultat transmis", () => {
  assert.match(agentReportPrompt({ title: "Séances", state: "succeeded", summary: "Dune à 20 h 30" }), /« Séances » — terminé\.\nDune à 20 h 30/);
  assert.match(agentReportPrompt({ title: "Tests", state: "failed", summary: null }), /— échoué\.\n\(aucun résultat\)/);
  assert.match(agentReportPrompt({ title: "Push", state: "cancelled", summary: "approbation expirée" }), /non lancé/);
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(" ");
const ASK = /Ne le restitue pas encore.*demande à l'utilisateur s'il veut/s;

test("résultat court (réponse rapide) : restitué tout de suite", () => {
  const p = agentReportPrompt({ title: "Météo", state: "succeeded", summary: "Il fera 12 degrés à Annecy, sans pluie." });
  assert.match(p, /C'est court : donne-le à l'utilisateur maintenant/);
  assert.doesNotMatch(p, ASK);
});

test("résultat long : annoncé, puis restitué seulement si l'utilisateur le veut", () => {
  const p = agentReportPrompt({ title: "Séances du cinéma", state: "succeeded", summary: words(DIRECT_REPORT_MAX_WORDS + 20) });
  assert.match(p, /dis en une phrase que « Séances du cinéma » est terminé/);
  assert.match(p, ASK);
  assert.match(p, /mot99/, "le résultat complet reste dans le contexte, pour le « oui »");
});

test("les sources (URL) ne comptent pas dans la longueur", () => {
  const urls = Array.from({ length: 30 }, (_, i) => `https://exemple.fr/page-${i}`).join(" ");
  assert.doesNotMatch(agentReportPrompt({ title: "x", state: "succeeded", summary: `${words(40)} Sources : ${urls}` }), ASK);
});

test("échec : dit tout de suite, même avec un long message", () => {
  assert.doesNotMatch(agentReportPrompt({ title: "Tests", state: "failed", summary: words(200) }), ASK);
});

test("brief : toujours annoncé avec une question (il est long par nature)", () => {
  const p = briefReportPrompt({ title: "Brief de veille — lundi", spoken: "La BCE a maintenu ses taux.", trigger: "scheduled" });
  assert.match(p, /le wrap automatique est prêt, puis demande à l'utilisateur s'il veut que tu le lui résumes/);
  assert.match(p, /La BCE a maintenu ses taux\./);
});

test("cours MetaApi : agents et veille passent par leurs outils, jamais par curl", () => {
  const agent = agentSystemPrompt([], NOW, undefined, true);
  assert.match(agent, /pars de tes outils de cours : market_price \(prix en direct\), market_history .* et market_indicators/);
  assert.match(agent, /N'essaie jamais d'appeler MetaApi toi-même \(curl ou autre\)/);
  assert.match(agent, /refais le même appel deux fois avant de passer au web, et dis-le/);
  assert.doesNotMatch(agentSystemPrompt([], NOW), /market_/, "sans MetaApi : pas d'outils de cours");
  const veille = veilleSystemPrompt([], NOW, undefined, undefined, true);
  assert.match(veille, /Les niveaux et variations de la rubrique Marchés .* en viennent/);
  assert.doesNotMatch(veilleSystemPrompt([], NOW), /market_/);
});

test("calendrier Forex Factory : Kopilia s'y fie d'abord ; agents et veille savent où le lire", () => {
  const persona = dialogueSystemPrompt([], NOW);
  assert.match(persona, /base-toi d'abord sur le calendrier économique Forex Factory avec economic_calendar/);
  assert.match(persona, /une fois sorti, le chiffre publié\. Pour ce qui vient de se passer.*news_recent.*ask_agent/);
  const file = "/x/data/calendar/forexfactory.md";
  assert.match(
    agentSystemPrompt([], NOW, file),
    /calendrier Forex Factory de la semaine, déjà en heure de Paris : le fichier \/x\/data\/calendar\/forexfactory\.md/,
  );
  assert.doesNotMatch(agentSystemPrompt([], NOW), /Forex Factory/, "pas de fichier : rien à lire");
  assert.match(veilleSystemPrompt([], NOW, undefined, file), /forexfactory\.md/);
  const since = new Date(2026, 9, 30, 21, 38).getTime();
  const task = briefTaskPrompt("scheduled", NOW, since, "Calendrier économique Forex Factory (…) :\nÀ venir :\nlundi 2 novembre :\n- 16:00 · USD · ISM");
  assert.match(
    task,
    /annonce publiée pendant la période, prends le chiffre publié quand il est indiqué \(« publié »\), sinon cherche le chiffre publié, et compare-le à la prévision/,
  );
  assert.match(task, /La rubrique À suivre s'appuie sur les annonces à venir[\s\S]*16:00 · USD · ISM/);
  assert.equal(
    briefTaskPrompt("manual", NOW, since),
    "Prépare le brief de veille du lundi 2 novembre 2026 (lancé à la demande de l'utilisateur) : le wrap de ce qui s'est passé depuis vendredi 30 octobre à 21:38 jusqu'à maintenant (lundi 2 novembre à 13:00).",
  );
});

test("veille : un session wrap condensé, uniquement du nouveau depuis le brief précédent", () => {
  const p = veilleSystemPrompt([], NOW, "2026-10-30_0700.md");
  assert.match(p, /« session wrap », comme les wraps de séance d'investingLive/);
  assert.match(p, /Règle d'or : uniquement du nouveau\. L'utilisateur connaît la toile de fond/);
  assert.match(p, /Le brief précédent est le fichier 2026-10-30_0700\.md du dossier courant : lis-le d'abord et ne répète rien/);
  assert.match(p, /https:\/\/investinglive\.com\/Tag\/session-wrap\//);
  assert.match(p, /dollar australien/);
  for (const section of ["# Wrap du", "## En bref", "## Titres", "## Marchés", "## Le récit", "## À suivre", "## Sources"]) {
    assert.ok(p.includes(`« ${section}`), `rubrique ${section}`);
  }
  assert.doesNotMatch(p, /thèmes de fond à surveiller/, "plus de rappel des thèmes de fond");
  assert.match(veilleSystemPrompt([], NOW), /Il n'y a pas de brief précédent\./);
});

test("persona : suit la consigne du rapport et sait répondre au « oui »", () => {
  assert.match(dialogueSystemPrompt([], NOW), /Suis la consigne entre crochets/);
  assert.match(dialogueSystemPrompt([], NOW), /S'il répond oui, restitue-le/);
});

test("mémoire apprise : notes d'environnement, recettes du dialogue en entier, index pour les agents", () => {
  const p = dialogueSystemPrompt(["Habite à Annecy."], NOW, {
    environment: ["Le courtier cote le forex avec le suffixe .i"],
    skills: {
      inline: [{ name: "donner-un-cours", description: "Prix demandé.", body: "## Étapes\n1. market_price, heure à la seconde." }],
      others: [{ name: "longue-recette", description: "Cas rare." }],
    },
    learning: true,
  });
  assert.match(p, /Notes sur ton environnement, apprises au fil des conversations : Le courtier cote le forex avec le suffixe \.i\./);
  assert.match(p, /### donner-un-cours \(Prix demandé\.\)\n## Étapes\n1\. market_price, heure à la seconde\./);
  assert.match(p, /ouvrir avec skill_view quand la demande correspond :\n- longue-recette : Cas rare\./);
  assert.match(p, /search_conversations avant de lui demander de répéter/);
  assert.match(p, /learn_from_conversation/);
  assert.match(p, /\[Apprentissage\] ne vient pas de lui/);
  const bare = dialogueSystemPrompt([], NOW);
  assert.doesNotMatch(bare, /Notes sur ton environnement|recettes|learn_from_conversation/, "rien appris : rien à dire");

  const agent = agentSystemPrompt([], NOW, undefined, false, {
    environment: ["Source fiable : investinglive"],
    skills: [{ name: "horaires-de-cinema", description: "Séances d'un cinéma." }],
  });
  assert.match(agent, /Notes sur ton environnement[^:]*: Source fiable : investinglive\./);
  assert.match(agent, /- horaires-de-cinema : Séances d'un cinéma\.\nAvant de commencer, regarde si une de ces recettes correspond à ta tâche/);
  assert.match(
    veilleSystemPrompt([], NOW, undefined, undefined, false, { skills: [{ name: "brief-de-veille", description: "Le brief." }] }),
    /- brief-de-veille : Le brief\./,
  );

  const report = learningReportPrompt([{ name: "donner-un-cours", reason: "Tu as demandé les prix à la seconde.", isNew: true }]);
  assert.match(report, /^\[Apprentissage\]/);
  assert.match(report, /- donner-un-cours \(nouvelle recette\) : Tu as demandé les prix à la seconde\./);
  assert.match(report, /appelle skill_decide avec approve/);
});

test("carnet de trader : Kopilia le tient à jour de lui-même, et l'IA des setups suit ses horizons", () => {
  const rule = "Considère comme swing une entrée en 1 heure, 4 heures ou daily.";
  const dialogue = dialogueSystemPrompt([], NOW, { marketPrices: true, setups: true, trading: [rule] });
  assert.match(dialogue, /écris-la de toi-même avec remember dans le carnet trading, même s'il ne parle pas de carnet/);
  assert.match(dialogue, /remplace-la \(replaces\)/);
  assert.match(dialogue, /Son carnet de trader aujourd'hui : Considère comme swing une entrée en 1 heure, 4 heures ou daily\./);
  assert.match(dialogueSystemPrompt([], NOW, { marketPrices: true, setups: true, trading: [] }), /Son carnet de trader est encore vide\./);
  // Les consignes seules (pour le relecteur) : sans contenu du carnet.
  const bare = dialogueSystemPrompt([], NOW, { marketPrices: true, setups: true });
  assert.match(bare, /Carnet de trader :/);
  assert.doesNotMatch(bare, /Son carnet de trader (aujourd'hui|est encore vide)/);
  assert.doesNotMatch(dialogueSystemPrompt([], NOW, { marketPrices: true }), /Carnet de trader/, "sans recherche de setups");

  const agent = setupSystemPrompt({ facts: [], trading: [rule] }, NOW);
  assert.match(agent, /Façon de trader de l'utilisateur[^\n]*\n- Considère comme swing une entrée en 1 heure, 4 heures ou daily\./);
  assert.match(
    agent,
    /c'est sa façon de trader ci-dessous qui le dit, et elle prime ; s'il n'en dit rien : intraday, entrée en 15 minutes ; swing, entrée en 1 heure ou 4 heures/,
  );
  const pass = setupPassPrompt({ reason: "après le wrap programmé", products: ["or"], hypotheses: [], scenarios: [] });
  assert.match(
    pass,
    /Les horizons de la passe sont ceux de sa façon de trader : s'il ne trade que le swing, seulement le swing ; s'il trade les deux, les deux ; si elle n'en dit rien, les deux\./,
  );
  assert.match(pass, /Chaque horizon a son propre tour d'horizon \(market_scan\)[^"]*un seul tour d'horizon ne couvre pas deux horizons/);
  assert.match(pass, /pour chaque horizon cherché, dans quelles unités de temps et ce que tu y as trouvé/);
  assert.match(pass, /sans en sauter aucun : la sobriété vaut pour les dossiers que tu ouvres, pas pour les horizons que tu cherches/);
});

test("tâches de fond : Kopilia garde ses tours courts et délègue à un agent d'action ; l'agent agit sans l'écran, sur sa façon de trader", () => {
  const dialogue = dialogueSystemPrompt([], NOW, { marketPrices: true });
  assert.match(dialogue, /Tes tours restent courts : tu ne fais toi-même qu'une ou deux actions/);
  assert.match(dialogue, /confie-la à un agent avec ask_agent et act/);
  assert.match(dialogue, /N'ouvre ni ne ferme jamais une série de graphiques pour faire un travail/);
  assert.match(dialogue, /redis en une phrase ce qui sera effacé et attends son oui/);
  assert.match(dialogue, /chart_indicators le fait en un seul appel, ouverts ou non, sans rien ouvrir à l'écran/);

  const research = agentSystemPrompt([], NOW, undefined, true, { trading: ["Utilise les exponentielles 50 et 200."] });
  assert.match(research, /Tu ne modifies rien\./);
  assert.doesNotMatch(research, /chart_draw|carnet de trader/, "un agent de recherche n'agit pas");
  const action = agentSystemPrompt([], NOW, undefined, true, { trading: ["Utilise les exponentielles 50 et 200."] }, true);
  assert.match(action, /Tu ne modifies aucun fichier\./);
  assert.match(action, /tu ne touches jamais à son écran/);
  assert.match(action, /N'efface ni ne supprime rien qui ne soit pas explicitement demandé/);
  assert.match(action, /Sa façon de trader \(son carnet de trader\) : Utilise les exponentielles 50 et 200\./);
});

test("Telegram : un graphique et son texte en un seul message ; « le même message » reprend tout ; l'aperçu dit l'image", () => {
  const p = dialogueSystemPrompt([], NOW, { telegram: { publics: ["public"] } });
  assert.match(p, /part en un seul telegram_send, chart et text ensemble : l'image avec son texte en légende, jamais en deux messages/);
  assert.match(p, /« Le même message », « renvoie-le sur le canal public » : reprends tout ce qui est parti, le texte et le graphique/);
  assert.match(p, /dis-lui ce qui part avec \(« avec le graphique de l'or en 15 minutes », ou « sans image »\)/);
});
