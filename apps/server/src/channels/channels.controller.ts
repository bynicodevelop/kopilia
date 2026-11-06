import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigService } from "../config/config.service.js";
import { InternalAuthGuard } from "../mcp/internal-auth.guard.js";
import { DashboardError, DashboardService } from "../dashboard/dashboard.service.js";
import { ChartTimeframe, TIMEFRAME_LABELS, isChartTimeframe } from "../market/timeframes.js";
import { TELEGRAM_NOT_CONFIGURED, TelegramChannel } from "./telegram.js";
import { ChartImageService } from "./chart-image.service.js";
import { TelegramDrafts, resolveTelegramTarget, spokenDraft } from "./telegram-targets.js";
import type { OutboundMessage, SendOutcome } from "./channel.js";
import { X_NOT_AVAILABLE, XComposer, xLength, xPostText } from "./x-compose.js";

/** Au-delà, Kopilia répond sans attendre la fin des nouvelles tentatives : le message partira dès que possible. */
export const SEND_WAIT_MS = 12_000;
const TEXT_MAX = 3500;

interface SendBody {
  text?: string;
  title?: string;
  chart?: string;
  timeframe?: string;
  channel?: string;
}

type ChartBody = Pick<SendBody, "chart" | "timeframe">;

/**
 * Les envois que Kopilia fait à la demande de l'utilisateur (API interne, jeton
 * du dialogue), avec au besoin l'image du graphique d'un produit. Vers son
 * canal technique, le message part tout de suite. Vers un canal public, il
 * part d'abord en aperçu dans le canal technique, avec la mention des
 * messages publics ; il n'est publié, tel quel, qu'à l'accord de
 * l'utilisateur (telegram/publish). Sur X, rien ne part de Kopilia : la
 * fenêtre de post s'ouvre, prête, et c'est lui qui publie (x).
 */
@Controller("internal")
@UseGuards(InternalAuthGuard)
export class ChannelsController {
  /** Attente au plus de l'issue d'un envoi (réduite en test). */
  waitMs = SEND_WAIT_MS;
  readonly drafts = new TelegramDrafts();

  constructor(
    private readonly config: ConfigService,
    private readonly telegram: TelegramChannel,
    private readonly charts: ChartImageService,
    private readonly dashboard: DashboardService,
    private readonly x: XComposer,
  ) {}

  @Post("telegram")
  async telegramSend(@Body() body: SendBody) {
    const text = String(body.text ?? "").trim();
    const title = String(body.title ?? "").trim();
    if (!text && !title && !body.chart) return { sent: false, error: "dis quoi envoyer (text), ou quel graphique (chart)" };
    if (text.length > TEXT_MAX) return { sent: false, error: `texte trop long (${text.length} caractères, ${TEXT_MAX} au plus)` };
    if (body.timeframe && !isChartTimeframe(body.timeframe)) return { sent: false, error: `unité de temps inconnue (« ${body.timeframe} »)` };
    const target = resolveTelegramTarget(body.channel, this.config.telegramChannels);
    if ("error" in target) return { sent: false, error: target.error };
    if (!this.config.telegramToken || (target.kind === "technical" && !this.telegram.enabled)) return { sent: false, error: TELEGRAM_NOT_CONFIGURED };

    const message: OutboundMessage = { text, ...(title ? { title } : {}) };
    const chart = await this.attachChart(message, body);
    if (chart && "error" in chart) return { sent: false, error: chart.error };
    // L'image dite en clair, jointe ou non : Kopilia la nomme à l'utilisateur, et l'absence d'image se remarque avant son « oui ».
    const chartInfo = { image: chart ? `le graphique ${chart.label}` : "aucune" };

    if (target.kind === "technical") {
      const outcome = await this.within(this.telegram.send(message));
      if (outcome === "pending") return pending();
      return { ...answer(outcome), ...(outcome.ok ? chartInfo : {}) };
    }

    // Un canal public : la mention en bas, un aperçu dans le canal technique, et rien de publié sans son accord.
    if (this.config.telegramPublicFooter) message.footer = this.config.telegramPublicFooter;
    const draft = this.drafts.add({ name: target.name, chat: target.chat, message });
    const reply = {
      sent: false,
      preview: true,
      draftId: draft.id,
      channel: target.name,
      text: spokenDraft(message),
      ...chartInfo,
    };
    if (!this.telegram.enabled)
      return { ...reply, note: "Pas de canal technique pour l'aperçu : relis ce texte à l'utilisateur ; publie-le (telegram_publish) seulement s'il dit oui." };
    void this.telegram.send({ text: `Aperçu pour le canal « ${target.name} » : il ne sera publié que sur ton « oui » à Kopilia.` });
    const outcome = await this.within(this.telegram.send(message));
    const shown = outcome !== "pending" && outcome.ok;
    return {
      ...reply,
      note: `${shown ? "Aperçu envoyé dans le canal technique." : "Aperçu non envoyé dans le canal technique."} Relis ce texte à l'utilisateur, dis-lui ${chart ? `qu'il part avec ${chartInfo.image}` : "qu'il part sans image"}, et demande-lui s'il le publie sur « ${target.name} » ; seulement s'il dit oui : telegram_publish avec draftId. S'il veut changer quelque chose, refais telegram_send.`,
    };
  }

  /** Publie un aperçu accepté par l'utilisateur, tel qu'il lui a été montré, une seule fois. */
  @Post("telegram/publish")
  async telegramPublish(@Body() body: { draftId?: string }) {
    const draft = body.draftId ? this.drafts.take(String(body.draftId)) : undefined;
    if (!draft) return { sent: false, error: "aperçu inconnu ou périmé (une demi-heure) : refais telegram_send" };
    const outcome = await this.within(this.telegram.sendTo(draft.chat, draft.message));
    if (outcome === "pending") return pending();
    return { ...answer(outcome), channel: draft.name };
  }

  /**
   * Prépare un post sur X : la fenêtre de post s'ouvre dans le navigateur du
   * Mac, le texte déjà écrit (mention comprise), le graphique demandé dans le
   * presse-papiers. Rien n'est publié : l'utilisateur colle l'image et clique
   * Poster lui-même. Un texte trop long pour X n'ouvre rien.
   */
  @Post("x")
  async xCompose(@Body() body: ChartBody & { text?: string }) {
    const text = String(body.text ?? "").trim();
    if (!text && !body.chart) return { opened: false, error: "dis quoi poster (text), ou quel graphique (chart)" };
    if (!this.x.enabled) return { opened: false, error: X_NOT_AVAILABLE };
    if (body.timeframe && !isChartTimeframe(body.timeframe)) return { opened: false, error: `unité de temps inconnue (« ${body.timeframe} »)` };

    const footer = this.config.xFooter;
    const post = xPostText(text, footer);
    const length = xLength(post);
    const max = this.config.xMaxChars;
    if (length > max) {
      const room = max - (footer ? xLength(footer) + 2 : 0);
      return {
        opened: false,
        error: `trop long pour X : ${length} signes comptés comme X, ${max} au plus${footer ? ", mention comprise" : ""} ; raccourcis le texte à ${room} signes et refais x_compose`,
      };
    }

    const message: OutboundMessage = { text: post };
    const chart = await this.attachChart(message, body);
    if (chart && "error" in chart) return { opened: false, error: chart.error };
    const outcome = await this.x.open(post, message.image);
    if (!outcome.ok) return { opened: false, error: outcome.error };

    const pasted = !!chart && outcome.imageCopied;
    const image = !chart
      ? "aucune"
      : pasted
        ? `le graphique ${chart.label}, dans le presse-papiers`
        : `aucune : le graphique ${chart.label} n'a pas pu être copié`;
    return {
      opened: true,
      text: post,
      length,
      image,
      note: `La fenêtre de post d'X est ouverte dans son navigateur, le texte déjà écrit. Dis-lui en une phrase de ${pasted ? "coller le graphique (Commande V), puis de " : ""}relire et de cliquer Poster : rien n'est publié sans son clic.${chart && !pasted ? " Dis-lui aussi que le graphique n'a pas pu être copié." : ""}`,
    };
  }

  /** Joint l'image du graphique demandé ; son libellé (« or en 15 minutes »), ou pourquoi elle manque. */
  private async attachChart(message: OutboundMessage, body: ChartBody): Promise<{ label: string } | { error: string } | undefined> {
    if (!body.chart) return undefined;
    try {
      const product = await this.dashboard.drawingProduct(body.chart);
      const tf: ChartTimeframe = isChartTimeframe(body.timeframe) ? body.timeframe : this.charts.timeframeOf(product.symbol);
      const image = await this.charts.render(product, tf);
      if (!Buffer.isBuffer(image)) return { error: `graphique non dessiné : ${image.error}` };
      message.image = image;
      return { label: `${product.name} en ${TIMEFRAME_LABELS[tf]}` };
    } catch (e) {
      if (e instanceof DashboardError) return { error: e.message };
      throw e;
    }
  }

  private within(p: Promise<SendOutcome>): Promise<SendOutcome | "pending"> {
    return Promise.race([p, sleep(this.waitMs, undefined, { ref: false }).then(() => "pending" as const)]);
  }
}

function answer(outcome: SendOutcome) {
  return outcome.ok ? { sent: true } : { sent: false, error: outcome.error };
}

function pending() {
  return { sent: false, pending: true, note: "Telegram tarde à répondre : le message partira dès que possible" };
}
