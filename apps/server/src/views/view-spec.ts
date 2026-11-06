import { z } from "zod";
import {
  MAX_VIEW_BLOCKS,
  VIEW_CATALOG,
  ViewBlock,
  ViewBlockInput,
  ViewProduct,
  ViewSpec,
  viewBlockInputSchema,
  viewBlockSummary,
  viewSpecSchema,
} from "@kopilia/contracts";
import { DashboardError } from "../dashboard/drawing.service.js";

/*
 * D'une vue envoyée par Kopilia (les produits par leur nom) à la vue gardée
 * (les produits résolus chez le courtier). Une erreur dit précisément quel
 * bloc et quel champ ne vont pas, pour que Kopilia corrige de lui-même, comme
 * après un appel d'outil mal formé. Pur, à la résolution des produits près.
 */

/** Le titre d'une vue, au plus. */
export const MAX_VIEW_TITLE = 60;

/** Résout un produit (« or » -> XAUUSD), ou dit pourquoi pas. */
export type ResolveProduct = (query: string) => Promise<ViewProduct | { error: string }>;

const inputSchema = z.object({ blocks: z.array(viewBlockInputSchema).min(1).max(MAX_VIEW_BLOCKS) });

/** Le titre d'une vue, nettoyé ; vide : une erreur. */
export function viewTitle(title: unknown): string {
  const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!t) throw new DashboardError("une vue a besoin d'un titre (title)");
  return t.slice(0, MAX_VIEW_TITLE);
}

/** Les blocs envoyés, vérifiés contre le catalogue, leurs produits résolus. */
export async function resolveView(blocks: unknown, resolve: ResolveProduct): Promise<ViewSpec> {
  const parsed = inputSchema.safeParse({ blocks });
  if (!parsed.success) throw new DashboardError(`vue refusée : ${issuesText(parsed.error, blocks)}`);
  const errors: string[] = [];
  const product = async (query: string, where: string): Promise<ViewProduct | undefined> => {
    const r = await resolve(query);
    if ("error" in r) {
      errors.push(`${where} : ${r.error}`);
      return undefined;
    }
    return { symbol: r.symbol, name: r.name, ...(r.digits !== undefined ? { digits: r.digits } : {}) };
  };
  const out = await Promise.all(parsed.data.blocks.map((b, i) => storedBlock(b, `bloc ${i + 1} (${b.type})`, product)));
  if (errors.length) throw new DashboardError(`vue refusée : ${errors.join(" ; ")}`);
  return viewSpecSchema.parse({ blocks: out.filter((b): b is ViewBlock => !!b) });
}

async function storedBlock(
  b: ViewBlockInput,
  where: string,
  product: (query: string, where: string) => Promise<ViewProduct | undefined>,
): Promise<ViewBlock | undefined> {
  switch (b.type) {
    case "quotes": {
      const products = await Promise.all([...new Set(b.symbols.map((s) => s.trim()))].map((s) => product(s, where)));
      const found = products.filter((p): p is ViewProduct => !!p);
      const unique = found.filter((p, i) => found.findIndex((q) => q.symbol === p.symbol) === i);
      return unique.length ? { type: "quotes", products: unique } : undefined;
    }
    case "sparkline": {
      const p = await product(b.symbol, where);
      return p ? { type: "sparkline", product: p, timeframe: b.timeframe ?? "1h", bars: b.bars ?? 48 } : undefined;
    }
    case "setups": {
      const p = b.symbol?.trim() ? await product(b.symbol, where) : undefined;
      if (b.symbol?.trim() && !p) return undefined;
      return { type: "setups", ...(p ? { product: p } : {}), ...(b.states?.length ? { states: [...new Set(b.states)] } : {}) };
    }
    case "hypotheses": {
      const p = b.symbol?.trim() ? await product(b.symbol, where) : undefined;
      if (b.symbol?.trim() && !p) return undefined;
      return { type: "hypotheses", ...(p ? { product: p } : {}) };
    }
    case "calendar":
      return { ...b, ...(b.currencies ? { currencies: b.currencies.map((c) => c.toUpperCase()) } : {}) };
    default:
      return b;
  }
}

/** Les erreurs de forme, une par champ : « bloc 2 (table), rows.1 : 2 cases pour 3 colonnes ». */
function issuesText(error: z.ZodError, blocks: unknown): string {
  const list = Array.isArray(blocks) ? blocks : [];
  return error.issues
    .slice(0, 6)
    .map((i) => {
      const [, index, ...rest] = i.path;
      if (i.path[0] !== "blocks" || typeof index !== "number")
        return i.path.length > 1 ? `blocs : ${i.message}` : i.message === "Required" ? "blocs requis" : i.message;
      const type = (list[index] as { type?: unknown } | undefined)?.type;
      const known = typeof type === "string" && type in VIEW_CATALOG;
      const label = `bloc ${index + 1}${known ? ` (${type})` : ""}`;
      if (i.code === "invalid_union_discriminator") return `${label} : genre inconnu « ${String(type)} » (genres : ${Object.keys(VIEW_CATALOG).join(", ")})`;
      return `${label}${rest.length ? `, ${rest.join(".")}` : ""} : ${i.message}`;
    })
    .join(" ; ");
}

/** Ce qu'une vue montre, en une ligne : « cours de or, argent ; calendrier USD ; setups ». */
export function viewSummary(spec: ViewSpec): string {
  return spec.blocks.map(viewBlockSummary).join(" ; ");
}

/** Le catalogue, pour Kopilia : chaque genre de bloc, vivant ou écrit, et ce qu'il montre. */
export function catalogText() {
  return {
    blocks: Object.entries(VIEW_CATALOG).map(([type, c]) => ({ type, label: c.label, live: c.live, description: c.description })),
    limits: `${MAX_VIEW_BLOCKS} blocs par vue ; titre de ${MAX_VIEW_TITLE} caractères au plus.`,
    note:
      "Les blocs vivants (live) restent à jour tout seuls : préfère-les pour un prix, une annonce, un setup. Les blocs écrits gardent ce que tu y mets, à la date où tu l'écris. " +
      "Pour un seul graphique, la liste de surveillance ou la liste des setups, les encarts natifs (panel_open kind chart, quotes, setups) restent les bons.",
  };
}
