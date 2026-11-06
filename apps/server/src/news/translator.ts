import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { NEWS_LEVELS, TurnOutcome, type NewsLevel } from "@kopilia/contracts";
import type { AppLogger } from "../common/logger.js";
import { ClaudeProcess } from "../session/claude-process.js";
import { OWN_TOOLS_ENV } from "../session/child-env.js";

/*
 * La traduction des titres par Haiku, par lots : un seul tour pour tous les
 * titres d'une lecture, dans un processus `claude -p` gardé ouvert (sans
 * outils ni serveurs MCP), relancé de temps en temps pour que son contexte ne
 * grossisse pas. La consigne et la lecture de la réponse sont pures, testées
 * à plat.
 */

/** Un titre à traduire. */
export interface TranslateInput {
  id: string;
  /** « 14:30 » (heure de Paris). */
  time: string;
  title: string;
  text?: string;
  /** L'annonce du calendrier dont c'est le chiffre : « Unemployment Claims, impact fort, consensus 197K ». */
  release?: string;
}

/** Un produit de sa liste : le symbole du courtier (celui des étiquettes) et son nom courant. */
export interface ListedProduct {
  symbol: string;
  name?: string;
}

/** Ce que Haiku rend pour un titre, vérifié. */
export interface Translation {
  id: string;
  fr: string;
  impact?: string;
  symbols: string[];
  level: NewsLevel;
}

/** Au plus ce nombre de titres par tour (le premier démarrage en a cent). */
export const BATCH_MAX = 25;
/** Le processus est relancé après ce nombre de tours : son contexte reste court. */
const TURNS_PER_PROCESS = 30;
const TURN_TIMEOUT_MS = 120_000;
/** Une ligne d'impact plus longue est coupée (elle doit rester très brève). */
const IMPACT_MAX = 90;

export const TRANSLATOR_PROMPT = `Tu traduis en français des titres de news financières en direct (FinancialJuice) pour un trader basé en France. Il ne travaille que sur sa liste de produits, donnée à chaque lot.

Pour chaque titre, rends un objet JSON :
- "id" : celui du titre ;
- "fr" : le titre en français, bref et naturel, comme une dépêche d'agence. Garde les noms propres et les sigles connus (Fed, BCE, BoE, BoJ, BNS, OPEP, IRIB, NYT). Chiffres à la française : virgule décimale, « 189 k », « 1,72 M », « 3,89 % », « 77 Gpi³ » pour le gaz. Un chiffre publié s'écrit « Inscriptions hebdomadaires au chômage (US) : 189 k, attendu 196 k, précédent 194 k ». Garde la source citée en fin de titre (« – NYT », « – IRIB »).
- "impact" : au plus 12 mots, l'effet probable sur les produits de sa liste, sur le ton d'un commentaire de marché (« Emploi solide : pression sur l'or, dollar soutenu. », « Risque sur l'offre : pétrole en hausse, or soutenu. »). null s'il n'y a pas d'effet direct et net. Jamais de conseil ni d'ordre : ni « achète », ni « vends », ni « il faut ».
- "symbols" : les symboles de sa liste que la news touche directement (au plus 3), [] sinon. Une devise touche ses paires (le dollar : EURUSD, USDJPY…), le dollar et les taux US touchent aussi l'or et le Nasdaq.
- "level" : "high" si elle peut faire bouger nettement un de ses produits tout de suite : décision ou propos d'un gouverneur sur les taux (Powell, Lagarde, Bailey, Ueda) ou d'un président (Trump) sur les droits de douane, le dollar ou une guerre, chiffre d'une annonce d'impact fort, choc géopolitique ou pétrolier majeur. "medium" si elle touche un produit de sa liste sans urgence (un membre de banque centrale qui répète la ligne, un chiffre secondaire). "low" sinon : une entreprise isolée, une enchère courante, un propos sans portée, un aperçu payant « FJElite ». Sois exigeant : "high" reste rare, quelques fois par jour.

Réponds uniquement par un tableau JSON, un objet par titre, dans l'ordre, sans texte autour.`;

/** Le tour d'un lot : sa liste, puis les titres. */
export function translateTurn(items: TranslateInput[], products: ListedProduct[]): string {
  const lines = items.map((i) =>
    JSON.stringify({
      id: i.id,
      heure: i.time,
      titre: i.title,
      ...(i.text ? { texte: i.text.slice(0, 400) } : {}),
      ...(i.release ? { annonce: i.release } : {}),
    }),
  );
  const list = products.map((p) => (p.name && p.name !== p.symbol ? `${p.symbol} (${p.name})` : p.symbol)).join(", ");
  return [`Sa liste (symboles à rendre tels quels) : ${list}.`, `Titres (${items.length}) :`, ...lines].join("\n");
}

/** Le tableau JSON de la réponse (entouré ou non de texte ou de ```), vérifié titre par titre ; les titres manquants sont absents. */
export function parseTranslations(reply: string, ids: string[], products: ListedProduct[]): Translation[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(ids);
  const allowed = new Map(products.map((p) => [p.symbol.toUpperCase(), p.symbol]));
  const out: Translation[] = [];
  const seen = new Set<string>();
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object") continue;
    const id = typeof r.id === "string" ? r.id : typeof r.id === "number" ? String(r.id) : "";
    const fr = typeof r.fr === "string" ? r.fr.replace(/\s+/g, " ").trim() : "";
    if (!wanted.has(id) || seen.has(id) || !fr) continue;
    seen.add(id);
    const impact = typeof r.impact === "string" ? shorten(r.impact.replace(/\s+/g, " ").trim(), IMPACT_MAX) : "";
    const symbols = Array.isArray(r.symbols)
      ? [...new Set(r.symbols.flatMap((s) => (typeof s === "string" && allowed.has(s.toUpperCase()) ? [allowed.get(s.toUpperCase())!] : [])))].slice(0, 3)
      : [];
    const level = NEWS_LEVELS.includes(r.level as NewsLevel) ? (r.level as NewsLevel) : "low";
    out.push({ id, fr, ...(impact && impact !== "null" ? { impact } : {}), symbols, level });
  }
  return out;
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 10)).replace(/[\s,;:]+$/, "")}…`;
}

/** Qui fait le tour : remplaçable en test par une fausse traduction. */
export type TranslateFn = (items: TranslateInput[], products: ListedProduct[]) => Promise<Translation[]>;

/**
 * Le traducteur : un processus Haiku sans outils, un tour par lot (au plus
 * BATCH_MAX titres), un lot à la fois.
 */
export class NewsTranslator {
  private proc?: ClaudeProcess;
  private turns = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: { bin: string; model?: string; dataDir: string; logger: AppLogger }) {}

  translate: TranslateFn = (items, products) => {
    const run = this.chain.then(() => this.run(items, products));
    this.chain = run.catch(() => undefined);
    return run;
  };

  stop(): void {
    this.proc?.stop();
    this.proc = undefined;
  }

  private async run(items: TranslateInput[], products: ListedProduct[]): Promise<Translation[]> {
    const out: Translation[] = [];
    for (let i = 0; i < items.length; i += BATCH_MAX) {
      const batch = items.slice(i, i + BATCH_MAX);
      const reply = await this.turn(translateTurn(batch, products));
      out.push(
        ...parseTranslations(
          reply,
          batch.map((b) => b.id),
          products,
        ),
      );
    }
    return out;
  }

  private async turn(content: string): Promise<string> {
    const proc = this.process();
    this.turns++;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        proc.sendTurn(content, () => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("traduction trop longue")), TURN_TIMEOUT_MS);
        }),
      ]);
      if (result.outcome !== TurnOutcome.Success) throw new Error(`traduction interrompue (${result.outcome})`);
      return result.final ?? result.text;
    } catch (e) {
      // Un processus en difficulté est relancé au lot suivant.
      this.stop();
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.turns >= TURNS_PER_PROCESS) this.stop();
    }
  }

  private process(): ClaudeProcess {
    if (this.proc) return this.proc;
    const cwd = resolve(this.opts.dataDir, "news");
    mkdirSync(cwd, { recursive: true });
    const proc = new ClaudeProcess({
      bin: this.opts.bin,
      cwd,
      model: this.opts.model,
      effort: "low",
      systemPrompt: TRANSLATOR_PROMPT,
      excludeDynamicSystemPrompt: true,
      // Aucun outil, aucun serveur MCP, aucune commande : du texte seulement.
      extraArgs: ["--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"],
      env: OWN_TOOLS_ENV,
      logger: this.opts.logger,
    });
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = undefined;
    });
    proc.on("fatal", (err: Error) => this.opts.logger.warn(`traducteur des news : ${err.message}`, "news"));
    proc.start();
    this.proc = proc;
    this.turns = 0;
    return proc;
  }
}
