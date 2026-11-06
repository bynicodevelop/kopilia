import { execFile } from "node:child_process";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "../config/config.service.js";
import { AppLogger } from "../common/logger.js";

/**
 * Notification du Mac (centre de notifications, avec un son), pour une alerte
 * qui se déclenche quand aucun écran n'est ouvert : le serveur tourne sur le
 * Mac de l'utilisateur, osascript suffit (rien à installer). Désactivée hors
 * macOS ou par KOPILIA_ALERT_NOTIFY=0.
 */
@Injectable()
export class DesktopNotifier {
  /** Lance la commande ; remplaçable en test. */
  run: (file: string, args: string[]) => void = (file, args) =>
    void execFile(file, args, { timeout: 10_000 }, (e) => {
      if (e) this.logger.warn(`notification du Mac impossible : ${e.message}`, "alerts");
    });

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  get enabled(): boolean {
    return this.config.alertNotify && process.platform === "darwin";
  }

  notify(title: string, body: string): void {
    if (!this.enabled) return;
    this.run("osascript", ["-e", `display notification ${appleText(body)} with title ${appleText(title)} sound name "Glass"`]);
  }
}

/** Une chaîne AppleScript : entre guillemets, barres obliques et guillemets échappés. */
export function appleText(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
