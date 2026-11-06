import type { ViewBlock, ViewSpec } from "@kopilia/contracts";
import { dateFormat } from "../format";

/*
 * Les vues vues de l'écran, sans Angular : la hauteur à prévoir pour garder
 * l'encart dans la fenêtre, l'heure d'une annonce, le tracé d'une courbe.
 */

/** Hauteur à peu près d'un bloc (px), pour garder la vue dans la fenêtre quand on la déplace. */
function blockHeight(b: ViewBlock): number {
  switch (b.type) {
    case "heading":
      return 28;
    case "text":
      return 10 + 20 * Math.ceil(b.text.length / 48);
    case "stat":
      return 62;
    case "table":
      return 36 + 28 * b.rows.length;
    case "list":
      return 8 + 34 * b.items.length;
    case "quotes":
      return 12 + 31 * b.products.length;
    case "sparkline":
      return 92;
    case "calendar":
      return 170;
    case "setups":
    case "hypotheses":
      return 130;
    case "brief":
      return 120;
  }
}

/** La vue entière : en-tête de l'encart, puis ses blocs ; au-delà de `max`, elle défile. */
export function viewHeight(spec: ViewSpec | undefined, max = 720): number {
  const blocks = spec?.blocks ?? [];
  return Math.min(max, 58 + blocks.reduce((h, b) => h + blockHeight(b) + 8, 0));
}

/** L'heure d'une annonce : « 14:30 » aujourd'hui, « jeu. 14:30 » un autre jour. */
export function eventTime(at: number, now = Date.now()): string {
  const clock = dateFormat("clock", { hour: "2-digit", minute: "2-digit" }).format(at);
  if (new Date(at).toDateString() === new Date(now).toDateString()) return clock;
  return `${dateFormat("weekday", { weekday: "short" }).format(at)} ${clock}`;
}

/** Les points d'une courbe dans un cadre w × h (marge d'un pixel), du plus ancien au plus récent. */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return values.map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 1 - ((v - lo) / span) * (h - 2)).toFixed(1)}`).join(" ");
}

/** La variation sur la période, en pour cent : « +0,42 % », et son sens. */
export function periodChange(first: number, last: number): { text: string; sign: number } | undefined {
  if (!first) return undefined;
  const pct = ((last - first) / first) * 100;
  const sign = Math.abs(pct) < 0.005 ? 0 : Math.sign(pct);
  return { text: `${pct > 0 ? "+" : ""}${pct.toFixed(2).replace(".", ",")} %`, sign };
}
