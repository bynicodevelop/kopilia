import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { NEWS_LEVELS, type NewsItem, type NewsLevel } from "@kopilia/contracts";
import { InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { SessionGuard } from "../http/session.guard.js";
import { MarketService } from "../market/market.service.js";
import { NewsService } from "./news.service.js";
import { newsLine } from "./news-texts.js";
import { localMoment, startOfDay } from "../common/dates.js";

/** Sans précision : la journée pour un produit (« pourquoi l'or monte ? »), sinon la dernière heure ; une recherche par mots porte sur toute l'archive. */
const DEFAULT_MINUTES = 60;
const MAX_LINES = 40;

/**
 * Les news pour Kopilia (outil news_recent du dialogue, jeton du dialogue) :
 * « pourquoi l'or monte ? », « quelles news ce matin ? », « qu'a dit Powell
 * la dernière fois ? ».
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class NewsController {
  constructor(
    private readonly news: NewsService,
    private readonly market: MarketService,
  ) {}

  @Get("news")
  async recent(
    @Query("symbol") symbol?: string,
    @Query("minutes") minutes?: string,
    @Query("since") sinceText?: string,
    @Query("query") query?: string,
    @Query("level") level?: string,
    @Query("limit") limit?: string,
  ) {
    if (!this.news.enabled) return { error: "les news en temps réel sont désactivées (KOPILIA_NEWS_FEED_URL vide)" };
    let product: { symbol: string; name: string } | undefined;
    if (symbol?.trim()) {
      const p = await this.market.resolve(symbol);
      if (!("symbol" in p)) return { error: p.error, ...(p.suggestions ? { suggestions: p.suggestions } : {}) };
      product = { symbol: p.symbol, name: p.name };
    }
    const now = Date.now();
    const q = query?.trim();
    const span = Number(minutes);
    const from = sinceText?.trim() ? sinceOf(sinceText, now) : undefined;
    if (sinceText?.trim() && from === undefined) return { error: `heure illisible (« ${sinceText} ») : « 13:00 » aujourd'hui, ou « AAAA-MM-JJ HH:MM »` };
    // Une recherche par mots remonte toute l'archive, sauf période donnée ; un produit, toute la journée.
    const since =
      from ??
      (minutes && Number.isFinite(span) && span > 0
        ? now - Math.min(span, 7 * 1440) * 60_000
        : q
          ? undefined
          : product
            ? startOfDay(now).getTime()
            : now - DEFAULT_MINUTES * 60_000);
    const minLevel = NEWS_LEVELS.find((l) => l === level) as NewsLevel | undefined;
    const found = this.news.list({
      ...(product ? { symbol: product.symbol } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(q ? { query: q } : {}),
      ...(minLevel ? { minLevel } : {}),
      limit: 300,
    });
    const items = pick(found, Math.min(Math.max(1, Number(limit) || 20), MAX_LINES));
    return {
      ...(product ? { product: product.name } : {}),
      news: items.map((n) => newsLine(n, now)),
      note: items.length
        ? "Les news de FinancialJuice, traduites, les plus récentes d'abord (heure de Paris, niveau, titre, impact probable, réaction du marché mesurée s'il y en a eu une). Réponds en une ou deux phrases : ce qui explique le mouvement ou ce qui compte, et l'orientation probable sur les produits concernés, sans tout lire."
        : "Aucune news sur cette période. Dis-le simplement ; propose d'élargir la période si c'est utile.",
    };
  }
}

/**
 * Au plus `limit` news, les fortes d'abord (une journée chargée en compte
 * beaucoup : la cause d'un mouvement ne doit pas tomber hors de la liste),
 * puis les plus récentes ; rendues de la plus récente à la plus ancienne.
 */
export function pick(items: NewsItem[], limit: number): NewsItem[] {
  if (items.length <= limit) return items;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const kept = new Set([...items].sort((a, b) => rank[a.level] - rank[b.level] || b.at - a.at).slice(0, limit));
  return items.filter((n) => kept.has(n));
}

/** « 13:00 » ou « 13h » : aujourd'hui à cette heure (heure du Mac) ; sinon une date et une heure complètes. */
export function sinceOf(text: string, now: number): number | undefined {
  const clock = /^(\d{1,2})\s*[:h]\s*(\d{2})?$/i.exec(text.trim());
  if (clock) {
    const d = startOfDay(now);
    d.setHours(Number(clock[1]), Number(clock[2] ?? 0), 0, 0);
    return Number(clock[1]) < 24 && Number(clock[2] ?? 0) < 60 ? d.getTime() : undefined;
  }
  return localMoment(text);
}

/** Les news pour l'encart News de l'écran (session de l'écran). */
@Controller("api/news")
@UseGuards(SessionGuard)
export class NewsScreenController {
  constructor(private readonly news: NewsService) {}

  @Get()
  list(@Query("symbol") symbol?: string, @Query("limit") limit?: string): NewsItem[] {
    return this.news.list({ ...(symbol ? { symbol } : {}), limit: Math.min(Math.max(1, Number(limit) || 80), 200) });
  }
}
