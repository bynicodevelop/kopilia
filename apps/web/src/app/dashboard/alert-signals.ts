/**
 * Ce que l'écran fait quand une alerte part, en plus du bandeau : deux notes
 * brèves (synthétisées, sans fichier), et une notification du navigateur si
 * la page est cachée et que l'utilisateur l'a permise (demandée quand il pose
 * sa première alerte : il faut un geste de sa part).
 */

let ctx: AudioContext | undefined;

/** Deux notes claires et courtes. Sans son possible (aucun geste encore sur la page), rien. */
export function ring(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const start = ctx.currentTime + 0.02;
    [880, 1320].forEach((freq, k) => {
      const t = start + k * 0.16;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch {
    /* pas d'audio sur cette page */
  }
}

/** Notification du navigateur, seulement si la page est cachée (sinon le bandeau suffit). */
export function notifyHidden(title: string, body: string, tag: string): void {
  try {
    if (typeof document === "undefined" || !document.hidden) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    new Notification(title, { body, tag });
  } catch {
    /* notifications indisponibles */
  }
}

/** Demande la permission des notifications, une fois (à appeler pendant un clic). */
export function askNotifications(): void {
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    /* notifications indisponibles */
  }
}
