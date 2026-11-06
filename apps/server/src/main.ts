import "./common/legacy-env.js";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response, NextFunction } from "express";
import { existsSync } from "node:fs";
import { AppModule } from "./app.module.js";
import { AppLogger } from "./common/logger.js";
import { ConfigService } from "./config/config.service.js";
import { GatewayService } from "./gateway/gateway.service.js";

const logger = new AppLogger();

// Filet de dernier recours : une erreur imprévue dans un écouteur, une minuterie
// ou une promesse oubliée est journalisée au lieu d'arrêter tout le serveur (et
// la conversation en cours avec lui). Les erreurs connues sont traitées sur place.
process.on("unhandledRejection", (reason) => {
  logger.error(`promesse rejetée sans traitement : ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`, "main");
});
process.on("uncaughtException", (err) => {
  logger.error(`exception non rattrapée : ${err.stack ?? err.message}`, "main");
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    bodyParser: true,
  });

  const config = app.get(ConfigService);
  const gateway = app.get(GatewayService);

  // Sert le build Angular (si présent) + repli SPA, hors /api, /ws et /internal
  // (l'API de contrôle du serveur MCP, qui doit toujours répondre en JSON).
  const isBackend = (path: string) => ["/api", "/ws", "/internal"].some((p) => path.startsWith(p));
  if (existsSync(config.webDist)) {
    app.useStaticAssets(config.webDist);
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" || isBackend(req.path)) return next();
      if (req.path.includes(".")) return next();
      res.sendFile("index.html", { root: config.webDist });
    });
  } else {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (isBackend(req.path)) return next();
      res.status(200).send("<h1>Kopilia</h1><p>Interface non construite. Lancez <code>pnpm build</code> puis rechargez.</p>");
    });
  }

  await app.init();

  // Attache le WebSocket au serveur HTTP sous-jacent, puis écoute sur loopback.
  const http = app.getHttpServer();
  gateway.attach(http);
  await app.listen(config.port, config.host);

  logger.log(`Kopilia prêt sur http://${config.host}:${config.port}`, "main");
  logger.log(`Racines projets: ${config.projectRoots.join(", ")}`, "main");
  if (!config.coordinationReady) logger.warn("coordination MCP inactive (serveur MCP non compilé)", "main");
  if (config.exposed) {
    logger.warn(`KOPILIA_HOST=${config.host} : Kopilia est joignable depuis le réseau, son API interne n'est protégée que par jeton`, "main");
  }

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.log(`arrêt (${sig})`, "main");
    // Filet de sécurité : ne jamais rester bloqué si l'arrêt propre traîne.
    setTimeout(() => {
      logger.warn("arrêt forcé : délai de 5 s dépassé", "main");
      process.exit(0);
    }, 5000).unref();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrap().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
