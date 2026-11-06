import type { ServerMessage } from "@kopilia/contracts";

/**
 * Les réponses qui attendent leur tour à l'écran. Une phrase dite pendant
 * que Kopilia répond ne coupe plus sa réponse (sauf « stop », « attends »…) :
 * celle de la phrase se prépare tout de suite (un graphique demandé s'ouvre
 * aussitôt), mais ne s'affiche et ne se dit qu'après. En attendant, ses
 * messages et ses trames de voix sont gardés ici, dans l'ordre d'arrivée,
 * pour être rejoués quand vient son tour. Un rapport de Kopilia (résultat
 * d'agent, brief) attend de la même façon la fin de ce qu'il disait.
 */
export interface WaitingReply {
  turnId: string;
  /** La phrase de l'utilisateur ; absente pour un rapport de Kopilia. */
  text?: string;
  /** Le rapport que Kopilia prend la parole pour faire. */
  report?: { title: string; briefId: string | null };
  /** Messages et trames de voix arrivés pendant l'attente, dans l'ordre. */
  backlog: Array<ServerMessage | ArrayBuffer>;
}

export class ReplyQueue {
  private waiting: WaitingReply[] = [];
  /** Flux de voix des réponses en attente (déclarés par leur `audio.start`). */
  private streams = new Map<number, WaitingReply>();

  get size(): number {
    return this.waiting.length;
  }

  add(reply: Omit<WaitingReply, "backlog">): void {
    this.waiting.push({ ...reply, backlog: [] });
  }

  /** Garde un message s'il est d'une réponse en attente ; faux sinon. */
  keep(msg: ServerMessage): boolean {
    const reply = msg.turnId ? this.waiting.find((r) => r.turnId === msg.turnId) : undefined;
    if (!reply) return false;
    if (msg.type === "audio.start") this.streams.set(msg.streamId, reply);
    reply.backlog.push(msg);
    return true;
  }

  /** Garde une trame de voix si elle est d'une réponse en attente ; faux sinon. */
  keepFrame(streamId: number, frame: ArrayBuffer): boolean {
    const reply = this.streams.get(streamId);
    if (!reply) return false;
    reply.backlog.push(frame);
    return true;
  }

  /** La réponse suivante, retirée de l'attente avec ce qui en est déjà arrivé. */
  next(): WaitingReply | undefined {
    const reply = this.waiting.shift();
    for (const [streamId, r] of this.streams) if (r === reply) this.streams.delete(streamId);
    return reply;
  }

  /** Tout est coupé : rien de ce qui attendait ne sera dit ni affiché. Renvoie leurs flux de voix, à faire taire. */
  clear(): number[] {
    const streams = [...this.streams.keys()];
    this.waiting = [];
    this.streams.clear();
    return streams;
  }
}
