import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../http/session.guard.js";
import { InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { TradingError } from "../trading/trading.service.js";
import { JOURNAL_DAYS, JournalError, JournalService } from "./journal.service.js";
import { journalText, journalTradeText, reviewText } from "./journal-texts.js";
import { bilanText } from "./journal-bilan.js";
import { BILAN_PERIODS, type BilanPeriod } from "@kopilia/contracts";

function periodOf(v?: string): BilanPeriod {
  return (BILAN_PERIODS as readonly string[]).includes(v ?? "") ? (v as BilanPeriod) : "week";
}

function days(v?: string): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : JOURNAL_DAYS;
}

/** Pour le dialogue : une erreur attendue revient en { error }, que le modèle lit. */
async function soft<T>(fn: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof JournalError || e instanceof TradingError) return { error: e.message };
    throw e;
  }
}

/** Le journal vu de l'écran : par fiche, la page d'un trade, et son graphique figé (SVG). */
@Controller("api/journal")
@UseGuards(SessionGuard)
export class JournalScreenController {
  constructor(private readonly journal: JournalService) {}

  @Get()
  list(@Query("days") d?: string) {
    return this.journal.listFull(days(d));
  }

  @Get("trades/:id")
  async page(@Param("id") id: string) {
    try {
      return await this.journal.fullPage(id);
    } catch (e) {
      if (e instanceof JournalError) throw new NotFoundException(e.message);
      throw e;
    }
  }

  /** Un bilan : le jour, la semaine, le mois (date AAAA-MM-JJ ou AAAA-MM), ou les N derniers jours. */
  @Get("bilan")
  async bilan(@Query("period") period?: string, @Query("date") date?: string, @Query("days") d?: string) {
    try {
      return await this.journal.bilan(periodOf(period), { ...(date ? { date } : {}), days: days(d) });
    } catch (e) {
      if (e instanceof JournalError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  @Get("reviews/:id")
  review(@Param("id") id: string) {
    const r = id === "latest" ? this.journal.latestReview() : this.journal.getReview(id);
    if (!r) throw new NotFoundException("aucune analyse de ton trading pour l'instant");
    return r;
  }

  @Get("trades/:id/chart.svg")
  @Header("content-type", "image/svg+xml; charset=utf-8")
  @Header("cache-control", "no-store")
  async chart(@Param("id") id: string) {
    const svg = await this.journal.chart(id);
    if (typeof svg !== "string") throw new BadRequestException(svg.error);
    return svg;
  }
}

/** Le journal pour le dialogue : le lire, y dicter une note, ouvrir la page d'un trade à l'écran. */
@Controller("internal/journal")
@UseGuards(InternalAuthGuard)
export class JournalControlController {
  constructor(private readonly journal: JournalService) {}

  @Get()
  async list(@Query("days") d?: string) {
    const n = days(d);
    const j = await this.journal.listFull(n);
    return { lines: journalText(j, n), ...(j.reviewing ? { reviewing: true } : {}) };
  }

  @Get("trade")
  trade(@Query("trade") trade?: string, @Query("product") product?: string) {
    return soft(async () => {
      const t = this.journal.find({ trade, product });
      return { tradeId: t.id, lines: journalTradeText(await this.journal.fullPage(t.id)) };
    });
  }

  /** Un bilan de ses trades, en lignes : du jour, de la semaine, du mois, ou des N derniers jours. */
  @Get("bilan")
  bilan(@Query("period") period?: string, @Query("date") date?: string, @Query("days") d?: string) {
    return soft(async () => {
      const b = await this.journal.bilan(periodOf(period), { ...(date ? { date } : {}), days: days(d) });
      return {
        lines: bilanText(b),
        note: "Dis-le-lui en deux ou trois phrases : le résultat, puis ce qui ressort (répartitions, ce qui revient). Des faits ; s'il t'a demandé ce que tu en penses, ton avis franc ensuite, appuyé sur eux. Pour le voir à l'écran : journal_show avec calendar.",
      };
    });
  }

  /** L'heure du bilan du soir, ou son arrêt. */
  @Post("settings")
  settings(@Body() body: { evening?: string | null }) {
    return soft(() => {
      if (body.evening === undefined) return { ...this.journal.settings() };
      const s = this.journal.setEvening(body.evening);
      return {
        ...s,
        note: s.evening
          ? `Dis-lui que son bilan du soir partira chaque jour à ${s.evening}, s'il a fermé des trades dans la journée (dit en appel, sinon sur Telegram)${s.lastEvening ? ", à partir de demain" : ""}.`
          : "Dis-lui que le bilan du soir est arrêté.",
      };
    });
  }

  /** La dernière analyse de son trading, en lignes. */
  @Get("review")
  lastReview() {
    const r = this.journal.latestReview();
    if (!r) return { none: true, note: "Aucune analyse encore : journal_analyze la lance, à sa demande." };
    return { reviewId: r.id, lines: reviewText(r), ...(this.journal.busy ? { reviewing: true } : {}) };
  }

  /** Lance l'analyse de son trading (en arrière-plan) ; le résultat revient de lui-même. */
  @Post("review")
  startReview(@Body() body: { days?: number }) {
    return soft(() => {
      const n = days(body.days !== undefined ? String(body.days) : undefined);
      const r = this.journal.review(body.days !== undefined ? n : 7);
      return {
        started: true,
        ...r,
        note: "Dis-lui en une phrase que tu analyses ses trades (leur nombre) et que tu reviens vers lui d'ici une à deux minutes ; le résultat te sera transmis de lui-même.",
      };
    });
  }

  @Post("note")
  note(@Body() body: { text?: string; trade?: string; product?: string }) {
    return soft(() => {
      const r = this.journal.note(String(body.text ?? ""), { trade: body.trade, product: body.product });
      return { tradeId: r.trade.id, name: r.trade.name, note: "Dis en quelques mots que c'est noté dans son journal, sur ce trade." };
    });
  }

  @Post("show")
  show(@Body() body: { trade?: string; product?: string; review?: boolean | string; calendar?: boolean | string }) {
    return soft(() => {
      if (body.calendar) {
        const key = this.journal.showCalendar(typeof body.calendar === "string" && body.calendar !== "now" ? body.calendar : undefined);
        return { calendar: key, note: "Le calendrier de son journal est à l'écran : dis-le en une phrase. Pour le bilan en mots : journal_bilan." };
      }
      if (body.review) {
        const r = this.journal.showReview(typeof body.review === "string" ? body.review : undefined);
        return { reviewId: r.id, lines: reviewText(r), note: "L'analyse est à l'écran : dis-le en une phrase." };
      }
      const t = this.journal.show({ trade: body.trade, product: body.product });
      return {
        tradeId: t.id,
        lines: journalTradeText(this.journal.page(t.id)),
        note: "La page du trade est à l'écran : dis-le en une phrase, avec son résultat.",
      };
    });
  }
}
