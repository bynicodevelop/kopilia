/*
 * La réponse de l'utilisateur à un ticket, reconnue par le code et non par
 * l'IA : « je confirme » envoie l'ordre ; « non », « annule », « laisse
 * tomber » le retire. Une phrase plus longue ou nuancée (« je confirme mais
 * avec un stop plus bas ») n'est pas une confirmation : elle va à Kopilia, qui
 * prépare un autre ticket. Pur, testé à plat.
 */

/** Au-delà, une phrase n'est plus une simple confirmation. */
const MAX_CONFIRM_WORDS = 6;

function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function ticketAnswer(text: string): "confirm" | "cancel" | undefined {
  const t = plain(text);
  if (!t) return undefined;
  const words = t.split(" ");
  const confirm = /\bconfirm(e|es|er|ee|ez|ons)?\b/.test(t);
  const negative = /\b(ne|n|pas|plus|jamais)\b/.test(t);
  if (confirm && negative) return "cancel";
  if (confirm && words.length <= MAX_CONFIRM_WORDS && !/\b(mais|sauf|avec|plutot|change|modifie)\b/.test(t)) return "confirm";
  if (/^(non|annule|annuler|annulez|laisse tomber|oublie|pas maintenant|n envoie pas|ne l envoie pas|stop)\b/.test(t)) return "cancel";
  return undefined;
}
