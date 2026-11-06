import { Injectable } from "@nestjs/common";
import { AppLogger } from "../common/logger.js";
import { DesktopNotifier } from "../alerts/desktop-notifier.js";
import type { OutboundChannel } from "./channel.js";
import { TelegramChannel } from "./telegram.js";
import { ChartImageService } from "./chart-image.service.js";
import { AwayNews, awayMessage, macTexts } from "./away-texts.js";

/**
 * Ce qui arrive quand aucun écran n'est ouvert : la notification du Mac
 * (alertes, setups, recherches qui en repèrent, comme avant), et les canaux
 * extérieurs configurés (Telegram) pour tout ce que l'utilisateur a choisi
 * d'y recevoir : ces mêmes nouvelles, le wrap (titre et « En bref ») et la fin
 * des agents et des tâches. Une alerte y part avec le graphique de son
 * produit. Rien ne bloque : l'image et l'envoi se font après coup, et un échec
 * est seulement journalisé. Micro coupé ou écrans tous cachés (un autre
 * onglet), ces mêmes nouvelles partent sur les canaux seulement (`relay`).
 */
@Injectable()
export class AwayNotifier {
  /** Les canaux où partent ces nouvelles ; un autre (Twitter…) s'ajoutera ici. */
  private readonly channels: OutboundChannel[];
  /** Le dernier envoi en cours (pour les tests, qui l'attendent). */
  last: Promise<void> = Promise.resolve();

  constructor(
    private readonly mac: DesktopNotifier,
    telegram: TelegramChannel,
    private readonly charts: ChartImageService,
    private readonly logger: AppLogger,
  ) {
    this.channels = [telegram];
  }

  /** Aucun écran ouvert : la notification du Mac, et les canaux extérieurs. */
  tell(news: AwayNews): void {
    const mac = macTexts(news);
    if (mac) this.mac.notify(mac.title, mac.detail);
    this.relay(news);
  }

  /**
   * Les canaux extérieurs seulement : une page est ouverte (micro coupé,
   * onglet caché), elle a déjà sonné et affiché son bandeau.
   */
  relay(news: AwayNews): void {
    const channels = this.channels.filter((c) => c.enabled);
    if (!channels.length) return;
    this.last = this.forward(news, channels).catch((e) => this.logger.warn(`nouvelle non transmise : ${(e as Error).message}`, "channels"));
  }

  private async forward(news: AwayNews, channels: OutboundChannel[]): Promise<void> {
    const message = awayMessage(news);
    if (news.kind === "alert") {
      // Sans graphique (courtier injoignable), l'alerte part quand même.
      const image = await this.charts.alertImage(news.fired).catch((e: Error) => ({ error: e.message }));
      if (Buffer.isBuffer(image)) message.image = image;
      else this.logger.warn(`graphique de l'alerte non dessiné : ${image.error}`, "channels");
    }
    await Promise.all(channels.map((c) => c.send(message)));
  }
}
