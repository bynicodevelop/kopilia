import { ALERT_CONDITION_NAMES, Alert, Drawing, fibLevelPrice, fibRatioLabel } from "@kopilia/contracts";
import { describeDrawing } from "../dashboard/drawing.service.js";
import { frenchPrice } from "../market/metaapi.js";
import { ChartTimeframe, TIMEFRAME_LABELS } from "../market/timeframes.js";
import { momentFr } from "../common/dates.js";
import type { AlertFired } from "./alert.service.js";

/*
 * Les alertes en mots : pour Kopilia (la note des encarts, ses outils, le tour
 * qu'il dit quand une alerte part) et pour l'écran (bandeau, notification).
 */

const STATE_TEXT: Record<Alert["state"], string> = {
  active: "active",
  paused: "suspendue",
  triggered: "déclenchée",
  expired: "expirée",
};

/**
 * Ce que l'alerte surveille : « à 3 950,00 », « sur la ligne à 3 950,00
 * « résistance » », « sur l'oblique de … », « sur le niveau 0,618 (3 976,19)
 * du retracement de Fibonacci de … », « sur la bande 3 940,00 – 3 950,00 ».
 */
export function alertTargetText(a: Alert, line?: Drawing): string {
  if (a.target.kind === "price") return `à ${frenchPrice(a.target.price, a.digits)}`;
  if (a.target.kind === "band") return `sur la bande ${frenchPrice(a.target.bottom, a.digits)} – ${frenchPrice(a.target.top, a.digits)}`;
  if (!line) return `sur le tracé ${a.target.drawingId}, effacé`;
  const fib = fibLevelOf(a, line);
  if (fib)
    return `sur le niveau ${fib.ratio} (${frenchPrice(fib.price, a.digits)}) ${fib.of}${describeDrawing(line, a.digits, { levels: false })} (${line.id})`;
  return `sur ${line.kind === "trendline" ? "l'" : "la "}${describeDrawing(line, a.digits)} (${line.id})`;
}

/** Le niveau d'un Fibonacci que suit l'alerte : son ratio (« 0,618 »), son prix, et « du » ou « de l'» devant le nom du tracé. */
function fibLevelOf(a: Alert, line?: Drawing): { ratio: string; price: number; of: string } | undefined {
  if (a.target.kind !== "drawing" || (line?.kind !== "fib" && line?.kind !== "fibext")) return undefined;
  const price = fibLevelPrice(line, a.target.level);
  if (price === undefined || a.target.level === undefined) return undefined;
  return { ratio: fibRatioLabel(a.target.level), price, of: line.kind === "fib" ? "du " : "de l'" };
}

/** Une alerte sur une zone (tracée ou bande) : on y entre, on ne la franchit pas. */
function isZone(a: Alert, line?: Drawing): boolean {
  return a.target.kind === "band" || line?.kind === "zone";
}

/** « une seule fois », « une fois par bougie de 1 heure », « sur clôture de bougie de 15 minutes ». */
export function triggerText(a: Alert): string {
  const tf = TIMEFRAME_LABELS[a.timeframe as ChartTimeframe] ?? a.timeframe;
  if (a.trigger === "bar") return `une fois par bougie de ${tf}`;
  if (a.trigger === "close") return `sur clôture de bougie de ${tf}`;
  if (a.trigger === "touch_close") return `à la clôture de la bougie de ${tf} qui la touche`;
  return "une seule fois";
}

/**
 * Ce que montre la bougie du contact, à sa clôture : « bougie de rejet :
 * mèche dans la zone, clôture revenue au-dessus », « clôture dans la zone,
 * pas de rejet pour l'instant », « clôture sous la zone : cassure ».
 */
export function verdictText(f: AlertFired): string {
  if (!f.verdict) return "";
  const zone = isZone(f.alert, f.drawing);
  const where = zone ? "la zone" : "la ligne";
  const back = f.direction === "down" ? "au-dessus" : "en dessous";
  const beyond = f.direction === "down" ? (zone ? "sous la zone" : "sous la ligne") : zone ? "au-dessus de la zone" : "au-dessus de la ligne";
  if (f.verdict === "rejection") return `bougie de rejet : mèche ${zone ? "dans" : "sur"} ${where}, clôture revenue ${back}`;
  if (f.verdict === "break") return `clôture ${beyond} : cassure`;
  return zone ? "clôture dans la zone, pas de rejet pour l'instant" : "clôture sur la ligne, pas de rejet pour l'instant";
}

/**
 * L'alerte pour Kopilia : « à 3 950,00 : franchit à la hausse, une seule fois,
 * active ; consigne : « … » ».
 */
export function describeAlert(a: Alert, line?: Drawing): string {
  const state = a.state === "triggered" && a.triggeredAt ? `déclenchée le ${momentFr(a.triggeredAt)}` : STATE_TEXT[a.state];
  const sense = isZone(a, line) ? ZONE_SENSE[a.condition] : ALERT_CONDITION_NAMES[a.condition].toLowerCase();
  const until = a.expiresAt && a.state !== "expired" ? `, jusqu'au ${momentFr(a.expiresAt)}` : "";
  const how = `${sense}, ${triggerText(a)}, ${state}${until}`;
  const note = a.message ? ` ; ${a.scenarioId ? "intention" : "consigne"} : « ${a.message} »` : "";
  return `${alertTargetText(a, line)} : ${how}${note}${a.scenarioId ? ` (alerte de l'IA, scénario ${a.scenarioId})` : ""}`;
}

/** Le sens d'une alerte sur une zone : y entrer par-dessous, par-dessus, ou de n'importe quel côté. */
const ZONE_SENSE: Record<Alert["condition"], string> = {
  cross: "entrée dans la zone (d'un côté ou de l'autre)",
  up: "entrée dans la zone par-dessous",
  down: "entrée dans la zone par-dessus",
};

/** Le bandeau de l'écran et la notification du Mac : « Or : ligne « résistance » franchie à la hausse », « 3 950,40 à 14:32:05 ». */
export function firedTexts(f: AlertFired): { title: string; detail: string } {
  const a = f.alert;
  const p = (v: number) => frenchPrice(v, a.digits);
  const sense = f.direction === "up" ? "à la hausse" : "à la baisse";
  const kind = f.drawing?.kind === "trendline" ? "oblique" : f.drawing?.kind === "zone" ? "zone" : "ligne";
  const named = f.drawing?.label ? ` « ${f.drawing.label} »` : "";
  const fib = fibLevelOf(a, f.drawing);
  const what =
    a.target.kind === "price"
      ? `${p(a.target.price)} franchi ${sense}`
      : isZone(a, f.drawing)
        ? `${a.target.kind === "band" ? "bande" : "zone"}${named} atteinte ${f.direction === "up" ? "par-dessous" : "par-dessus"}`
        : fib
          ? `niveau ${fib.ratio} ${fib.of}${f.drawing?.kind === "fib" ? "retracement" : "extension"}${named} franchi ${sense}`
          : `${kind}${named} franchie ${sense}`;
  if (f.verdict) {
    // Clôture après contact : le titre dit ce que montre la bougie.
    const on =
      a.target.kind === "price"
        ? `${p(a.target.price)}`
        : isZone(a, f.drawing)
          ? `la ${a.target.kind === "band" ? "bande" : "zone"}${named}`
          : `la ${kind}${named}`;
    const head = f.verdict === "rejection" ? `bougie de rejet sur ${on}` : f.verdict === "break" ? `cassure de ${on}` : `bougie close dans ${on}`;
    const tf = TIMEFRAME_LABELS[a.timeframe as ChartTimeframe] ?? a.timeframe;
    const c = f.candle;
    const shape = c ? `bougie ${tf} : ouverture ${p(c.o)}, plus haut ${p(c.h)}, plus bas ${p(c.l)}, clôture ${p(c.c)} à ${clockSeconds(f.at)}` : "";
    return { title: `${capitalize(a.name)} : ${head}`, detail: [verdictText(f), shape].filter(Boolean).join(" · ") };
  }
  const detail = [
    `${p(f.price)} à ${clockSeconds(f.at)}${f.wick ? " (mèche)" : ""}`,
    f.close ? `clôture ${TIMEFRAME_LABELS[a.timeframe as ChartTimeframe] ?? a.timeframe}` : "",
    a.target.kind !== "price" ? `niveau ${p(f.level)}` : "",
    f.whileAway ? "pendant l'arrêt du serveur" : "",
  ].filter(Boolean);
  return { title: `${capitalize(a.name)} : ${what}`, detail: detail.join(" · ") };
}

/**
 * Un déclenchement, en une phrase de faits pour le tour que Kopilia dit :
 * « or (XAUUSD) : le prix a franchi à la hausse la ligne à 3 950,00
 * « résistance » ; il était à 3 950,40, à 14:32:05 ».
 */
export function alertNewsLine(f: AlertFired, now = Date.now()): string {
  const a = f.alert;
  const p = (v: number) => frenchPrice(v, a.digits);
  const sense = f.direction === "up" ? "à la hausse" : "à la baisse";
  const when = sameDay(f.at, now) ? `à ${clockSeconds(f.at)}` : `le ${momentFr(f.at)}`;
  let what: string;
  if (a.target.kind === "price") what = `le niveau de ${p(a.target.price)} (alerte de prix)`;
  else if (a.target.kind === "band") what = `le bord de la bande ${p(a.target.bottom)} – ${p(a.target.top)}, à ${p(f.level)}`;
  else if (!f.drawing) what = `un tracé, effacé depuis, au niveau de ${p(f.level)}`;
  else if (f.drawing.kind === "trendline") what = `l'${describeDrawing(f.drawing, a.digits)}, qui passait à ${p(f.level)}`;
  else if (f.drawing.kind === "zone") what = `le bord de la ${describeDrawing(f.drawing, a.digits)}, à ${p(f.level)}`;
  else if (f.drawing.kind === "fib" || f.drawing.kind === "fibext") {
    const fib = fibLevelOf(a, f.drawing);
    what = `le niveau ${fib?.ratio ?? "?"} ${fib?.of ?? "du "}${describeDrawing(f.drawing, a.digits, { levels: false })}, à ${p(f.level)}`;
  } else what = `la ${describeDrawing(f.drawing, a.digits)}`;
  const tf = TIMEFRAME_LABELS[a.timeframe as ChartTimeframe] ?? a.timeframe;
  if (f.candle) {
    // Clôture après contact : le contact, puis la bougie qui a touché, close, et ce qu'elle montre.
    const c = f.candle;
    const touched =
      a.target.kind === "band"
        ? `est entré dans la bande ${p(a.target.bottom)} – ${p(a.target.top)}`
        : f.drawing?.kind === "zone"
          ? `est entré dans la ${describeDrawing(f.drawing, a.digits)}`
          : `a touché ${what}`;
    return `${a.name} (${a.symbol}) : le prix ${touched} (${p(f.touchPrice ?? f.level)}), puis la bougie de ${tf} du contact a clôturé à ${p(c.c)}, ${when} (ouverture ${p(c.o)}, plus haut ${p(c.h)}, plus bas ${p(c.l)}) : ${verdictText(f)}`;
  }
  const how = f.close
    ? `une bougie de ${tf} a clôturé de l'autre côté, à ${p(f.price)}, ${when}`
    : f.wick
      ? `par une mèche entre deux cotations (${f.direction === "up" ? "plus haut" : "plus bas"} de la minute : ${p(f.price)}), ${when}`
      : `il était à ${p(f.price)}, ${when}`;
  const away = f.whileAway ? " ; c'est arrivé pendant que le serveur était arrêté, constaté à sa reprise" : "";
  return `${a.name} (${a.symbol}) : le prix a franchi ${sense} ${what} ; ${how}${away}`;
}

/** « 14:32:05 », heure locale. */
function clockSeconds(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
