import { type Scenario, isOpenScenario } from "@kopilia/contracts";

/*
 * La liste des setups repérés, sur l'écran principal : pure, testée à plat.
 * Dans les mots de l'utilisateur : un scénario surveillé est un setup « en
 * attente » (repéré, son déclencheur n'est pas encore arrivé), un setup
 * proposé est « déclenché ».
 */

/** Les setups en cours : les déclenchés d'abord, puis les plus récemment repérés. */
export function watchlist(scenarios: readonly Scenario[]): Scenario[] {
  return scenarios
    .filter((s) => isOpenScenario(s.state))
    .sort((a, b) => Number(b.state === "proposed") - Number(a.state === "proposed") || b.createdAt - a.createdAt);
}

/** Ce qu'attend un setup, sans le nom du produit en tête de son titre : « rebond sur le support 1h 4 021–4 028 ». */
export function setupLabel(s: Pick<Scenario, "title" | "name">): string {
  const prefix = `${s.name} : `;
  return s.title.toLowerCase().startsWith(prefix.toLowerCase()) ? s.title.slice(prefix.length) : s.title;
}

/** « en attente » ou « déclenché ». */
export function setupState(s: Pick<Scenario, "state">): string {
  return s.state === "proposed" ? "déclenché" : "en attente";
}
