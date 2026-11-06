import type { DatabaseService } from "../db/database.service.js";
import { frenchPrice } from "../market/metaapi.js";

/*
 * Ce que la relecture tire de la recherche d'opportunités pour le carnet de la
 * façon de trader : les réactions de l'utilisateur aux setups, ses
 * hypothèses, les exemples qu'il a montrés, ce qu'il a tracé, et les niveaux
 * de l'IA qu'il a gardés ou retirés, entre deux instants. Lu directement en base : la relecture ne dépend pas des services
 * de la recherche d'opportunités.
 */

const KIND_NAMES: Record<string, string> = { hline: "ligne(s) horizontale(s)", trendline: "oblique(s)", zone: "zone(s)" };

/** Les signaux de la fenêtre (from exclu, to inclus), une ligne chacun ; vide s'il n'y en a pas. */
export function tradingSignals(db: DatabaseService, from: number, to: number): string[] {
  const out: string[] = [];
  const reactions = db.db
    .prepare(
      `SELECT e.text, s.symbol, s.spec FROM scenario_events e JOIN scenarios s ON s.id = e.scenario_id
       WHERE e.kind = 'feedback' AND e.at > ? AND e.at <= ? AND e.text NOT LIKE 'L''utilisateur a %ton niveau%' ORDER BY e.at`,
    )
    .all(from, to) as Array<{ text: string; symbol: string; spec: string }>;
  for (const r of reactions) {
    const spec = JSON.parse(r.spec) as { title?: string; direction?: string; timeframe?: string; plan?: string };
    out.push(
      `Réaction à un setup de l'IA (« ${spec.title ?? r.symbol} », ${spec.direction === "long" ? "achat" : "vente"} ${spec.timeframe ?? ""}) : ${r.text}`,
    );
  }
  const hypotheses = db.db
    .prepare("SELECT statement, bias, horizon, invalidation FROM hypotheses WHERE author = 'user' AND created_at > ? AND created_at <= ? ORDER BY created_at")
    .all(from, to) as Array<{ statement: string; bias: string; horizon: string; invalidation: string }>;
  for (const h of hypotheses) out.push(`Hypothèse de l'utilisateur (${h.horizon}) : ${h.statement} ; invalidée si : ${h.invalidation}`);
  const examples = db.db
    .prepare("SELECT name, timeframe, positive, note FROM setup_examples WHERE created_at > ? AND created_at <= ? ORDER BY created_at")
    .all(from, to) as Array<{ name: string; timeframe: string; positive: number; note: string | null }>;
  for (const e of examples)
    out.push(
      `${e.positive ? "Setup montré par l'utilisateur" : "Contre-exemple montré par l'utilisateur"} : ${e.name} ${e.timeframe}${e.note ? `, « ${e.note} »` : ""}`,
    );
  const drawn = db.db
    .prepare(
      // Un niveau de l'IA gardé devient un tracé de l'utilisateur, avec sa raison : compté plus bas, pas ici.
      "SELECT kind, symbol, COUNT(*) AS n FROM drawings WHERE created_by = 'user' AND reason IS NULL AND created_at > ? AND created_at <= ? GROUP BY kind, symbol ORDER BY n DESC",
    )
    .all(from, to) as Array<{ kind: string; symbol: string; n: number }>;
  if (drawn.length)
    out.push(`Tracés posés par l'utilisateur sur la période : ${drawn.map((d) => `${d.n} ${KIND_NAMES[d.kind] ?? d.kind} sur ${d.symbol}`).join(", ")}`);
  const levels = db.db
    .prepare("SELECT symbol, kind, spec, label, reason, verdict, note FROM level_feedback WHERE created_at > ? AND created_at <= ? ORDER BY created_at")
    .all(from, to) as Array<{ symbol: string; kind: string; spec: string; label: string | null; reason: string | null; verdict: string; note: string | null }>;
  for (const l of levels)
    out.push(
      `Niveau de l'IA ${l.verdict === "keep" ? "gardé" : "retiré"} par l'utilisateur sur ${l.symbol} : ${shapeText(l.kind, l.spec)}${l.label ? ` « ${l.label} »` : ""}${l.reason ? ` (l'IA : ${l.reason})` : ""}${l.note ? ` ; lui : « ${l.note} »` : ""}`,
    );
  return out;
}

/** « zone 28 089 – 28 138 », « ligne à 1,0850 », « oblique de 4 020 à 4 060 ». */
function shapeText(kind: string, spec: string): string {
  try {
    const s = JSON.parse(spec) as { price?: number; top?: number; bottom?: number; a?: { price: number }; b?: { price: number } };
    if (kind === "zone" && s.top !== undefined && s.bottom !== undefined) return `zone ${frenchPrice(s.bottom)} – ${frenchPrice(s.top)}`;
    if (kind === "hline" && s.price !== undefined) return `ligne à ${frenchPrice(s.price)}`;
    if (kind === "trendline" && s.a && s.b) return `oblique de ${frenchPrice(s.a.price)} à ${frenchPrice(s.b.price)}`;
  } catch {
    /* forme illisible : son genre suffit */
  }
  return KIND_NAMES[kind] ?? kind;
}
