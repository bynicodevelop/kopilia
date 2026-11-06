/**
 * Hallucinations connues de Whisper sur du bruit ou du silence, surtout en
 * français (héritées des sous-titres de son corpus d'entraînement). Avec un
 * micro ouvert en continu, elles déclencheraient des tours fantômes.
 *
 * Volontairement conservateur : on ne rejette que des formules complètes,
 * jamais un mot isolé qu'un utilisateur pourrait vraiment dire.
 */
const HALLUCINATIONS: RegExp[] = [
  /sous-?titr(?:es|age)\s+(?:réalisés?|effectués?|faits?)\s+par/i,
  /sous-?titrage\s+st'?\s*\d+/i,
  /amara\.org/i,
  /^merci d'avoir regardé/i,
  /n'oubliez pas de (?:vous abonner|liker|mettre un like)/i,
  /^[\s.…!]*(?:musique|applaudissements|rires|silence|bruit de fond)[\s.…!]*$/i,
  /^\s*[[(][^\])]*[\])]\s*$/, // annotation seule : « [Musique] », « (silence) »
];

/** Vrai si la transcription est vide ou n'est qu'une hallucination connue. */
export function isLikelyHallucination(text: string): boolean {
  const t = text.trim();
  if (!/\p{L}/u.test(t)) return true; // aucune lettre
  return HALLUCINATIONS.some((re) => re.test(t));
}

/**
 * Sur du bruit, Whisper recopie parfois son amorce (la liste de vocabulaire).
 * Vrai si la transcription n'est qu'un extrait de cette liste, d'au moins trois
 * mots : un vrai « Kopilia ? » ou « La BCE » isolé reste accepté.
 */
export function isPromptEcho(text: string, prompt: string | undefined): boolean {
  if (!prompt) return false;
  const t = normalize(text);
  return t.split(" ").length >= 3 && normalize(prompt).includes(t);
}

/**
 * Ce qui demande à Kopilia de se taire, en début de phrase. Une phrase dite
 * pendant qu'il répond ne le coupe que si elle commence ainsi (« Stop. »,
 * « Attends, plutôt l'or. ») ; toute autre (« Ouvre le Nasdaq. ») laisse
 * finir sa réponse et passe après elle.
 */
const STOP_WORDS = [
  "stop",
  "stoppe",
  // « Stop » dit pendant que Kopilia parle, tel que Whisper l'a parfois transcrit (mesuré).
  "stomp",
  "stump",
  "arrete",
  "arretez",
  "attends",
  "attend",
  "attendez",
  "tais toi",
  "taisez vous",
  "chut",
  "silence",
  "ca suffit",
  "laisse tomber",
  "non",
];
/** Expressions de marché qui commencent comme un mot d'arrêt. */
const NOT_STOPS = ["stop loss", "non farm"];
/** Admis devant le mot d'arrêt : une hésitation, ou le nom de Kopilia. */
const LEAD_INS = new Set(["euh", "heu", "he", "eh", "oh", "ok", "okay", "kopilia", "copilia"]);

/** Vrai si la phrase demande à Kopilia de se taire : elle coupe la réponse en cours. */
export function cutsReply(text: string): boolean {
  const words = normalize(text).split(" ");
  let i = 0;
  while (i < words.length - 1 && LEAD_INS.has(words[i])) i++;
  const rest = words.slice(i).join(" ");
  const startsWith = (w: string) => rest === w || rest.startsWith(`${w} `);
  return STOP_WORDS.some(startsWith) && !NOT_STOPS.some(startsWith);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Mots après lesquels une phrase française ne s'arrête pas : articles,
 * prépositions, conjonctions, déterminants, pronoms sujets ou compléments
 * placés avant le verbe. « Envoie le », « Fais-moi un », « J'imagine une
 * entrée au niveau des » : l'utilisateur a marqué une pause, il n'a pas fini.
 * Pas les pronoms qui peuvent finir une phrase (« c'est pour vous », « à moi »).
 */
const DANGLING = new Set([
  "le",
  "la",
  "les",
  "l",
  "un",
  "une",
  "des",
  "du",
  "de",
  "d",
  "au",
  "aux",
  "a",
  "sur",
  "sous",
  "avec",
  "sans",
  "pour",
  "par",
  "dans",
  "en",
  "vers",
  "chez",
  "entre",
  "contre",
  "depuis",
  "avant",
  "apres",
  "et",
  "ou",
  "mais",
  "donc",
  "car",
  "que",
  "qu",
  "qui",
  "dont",
  "quand",
  "lorsque",
  "puisque",
  "comme",
  "mon",
  "ma",
  "mes",
  "ton",
  "ta",
  "tes",
  "son",
  "sa",
  "ses",
  "notre",
  "nos",
  "votre",
  "vos",
  "leur",
  "leurs",
  "ce",
  "cet",
  "cette",
  "ces",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "je",
  "j",
  "tu",
  "il",
  "ils",
  "on",
  "me",
  "m",
  "te",
  "t",
  "se",
  "s",
  "y",
]);

/**
 * La phrase transcrite a l'air inachevée : Whisper l'a terminée par des points
 * de suspension, ou elle finit sur un mot qui ne termine pas une phrase. Une
 * question ou une exclamation est toujours finie.
 */
export function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t || /[?!]\s*["»”]?$/.test(t)) return false;
  if (/(\.\.\.|…)\s*["»”]?$/.test(t) || /[’']$/.test(t)) return true;
  // Le dernier mot, sans le point que Whisper ajoute parfois ; un mot à trait d'union (« envoie-le ») est entier.
  const last =
    t
      .replace(/[.,;:\s]+$/, "")
      .split(/[\s’']+/)
      .pop() ?? "";
  return DANGLING.has(normalize(last).replace(/\s+/g, ""));
}

/** Les deux morceaux d'une phrase coupée par une pause, en une seule. */
export function joinPhrases(first: string, rest: string): string {
  // Whisper met une majuscule au début de la suite : elle n'a plus lieu d'être (« Envoie le dollar… »), sauf pour un sigle.
  const next = rest.trim().replace(/^(\p{Lu})(?=['’]?\p{Ll})/u, (c) => c.toLowerCase());
  return `${first.trim().replace(/\s*(\.\.\.|…)$/, "")} ${next}`;
}
