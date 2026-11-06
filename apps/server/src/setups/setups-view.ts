import { Injectable } from "@nestjs/common";
import type { DrawingSuggestion, Hypothesis, Scenario, SetupStatsRow } from "@kopilia/contracts";
import { ScenarioService } from "./scenario.service.js";
import { LevelService } from "./level.service.js";

/** Les hypothèses qui ont changé d'état restent montrées ce temps-là. */
const RECENT_HYPOTHESES_MS = 24 * 3_600_000;

/** Ce que l'écran montre de la recherche d'opportunités (message setups.updated). */
export interface SetupsView {
  hypotheses: Hypothesis[];
  scenarios: Scenario[];
  stats: SetupStatsRow[];
  suggestions: DrawingSuggestion[];
}

/**
 * L'état de la recherche d'opportunités pour les écrans : hypothèses,
 * scénarios ouverts et récents avec leur fil, résultats, suggestions de l'IA
 * sur les tracés de l'utilisateur.
 */
@Injectable()
export class SetupsUpdatedView {
  constructor(
    private readonly scenarios: ScenarioService,
    private readonly levels: LevelService,
  ) {}

  build(): SetupsView {
    return {
      hypotheses: this.scenarios.hypotheses({ since: Date.now() - RECENT_HYPOTHESES_MS }),
      scenarios: this.scenarios.list({ recent: true, events: true }),
      stats: this.scenarios.stats(),
      suggestions: this.levels.suggestions(),
    };
  }
}
