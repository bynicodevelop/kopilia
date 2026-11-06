import { Injectable, LoggerService } from "@nestjs/common";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Journal minimal sur stderr (stdout reste réservé au protocole des workers).
 * Ne journalise jamais de valeurs de secrets ou d'identifiants (seulement leurs noms).
 */
@Injectable()
export class AppLogger implements LoggerService {
  private threshold = ORDER[(process.env.KOPILIA_LOG_LEVEL as Level) ?? "info"];

  private emit(level: Level, context: string, msg: unknown, ...rest: unknown[]) {
    if (ORDER[level] < this.threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${context}] ${String(msg)}`;
    process.stderr.write(line + (rest.length ? " " + rest.map(String).join(" ") : "") + "\n");
  }

  log(message: unknown, context = "app") {
    this.emit("info", context, message);
  }
  debug(message: unknown, context = "app") {
    this.emit("debug", context, message);
  }
  warn(message: unknown, context = "app") {
    this.emit("warn", context, message);
  }
  error(message: unknown, context = "app", trace?: unknown) {
    this.emit("error", context, message, trace ?? "");
  }
}
