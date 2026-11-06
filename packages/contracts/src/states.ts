/** États d'interaction affichés dans l'interface Angular. */
export enum PipelineState {
  Idle = "idle",
  Listening = "listening",
  Transcribing = "transcribing",
  Thinking = "thinking",
  Speaking = "speaking",
  Error = "error",
}

/** Cycle de vie d'une tâche de travail (session Claude Code distincte). */
export enum JobState {
  Queued = "queued",
  Running = "running",
  AwaitingApproval = "awaiting_approval",
  Succeeded = "succeeded",
  Failed = "failed",
  Cancelled = "cancelled",
  /** Issue inconnue après crash/déconnexion ; vérité = fichiers du dépôt. */
  Unverified = "unverified",
}

/** Issue d'un tour de dialogue Claude. */
export enum TurnOutcome {
  Success = "success",
  Error = "error",
  Interrupted = "interrupted",
}
