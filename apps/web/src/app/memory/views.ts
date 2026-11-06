/** Mémoire de Kopilia telle que l'écran la reçoit (GET /api/learning) : carnets, recettes, journal. */
export interface MemoryEntryView {
  id: string;
  content: string;
  kind: string;
  createdAt: number;
  provenance: string;
}
export interface NotebookView {
  used: number;
  budget: number;
  entries: MemoryEntryView[];
}
export interface SkillCardView {
  name: string;
  version: number;
  /** draft : proposée, en attente ; active ; archived. */
  state: string;
  audience: string;
  description: string;
  body: string;
  files: string[];
  reason: string | null;
  createdAt: number;
  pinned: boolean;
  uses: number;
  lastUsedAt: number | null;
  /** Modification proposée : la version suivie aujourd'hui, pour comparer. */
  activeBody: string | null;
}
export interface LearningChangeView {
  kind: "memory" | "skill";
  action: string;
  target: string;
  detail: string;
  id?: string;
  previous?: string;
  previousId?: string;
  state?: string;
}
export interface LearningRunView {
  id: string;
  kind: "review" | "curator";
  state: string;
  summary: string | null;
  createdAt: number;
  finishedAt: number | null;
  changes: LearningChangeView[];
}
export interface LearningView {
  profile: NotebookView;
  environment: NotebookView;
  /** Sa façon de trader (absent devant un serveur pas encore redémarré). */
  trading?: NotebookView;
  skills: SkillCardView[];
  runs: LearningRunView[];
  reviewing: boolean;
}
