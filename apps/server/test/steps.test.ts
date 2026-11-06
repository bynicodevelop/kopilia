import { test } from "node:test";
import assert from "node:assert/strict";
import { stepLabel } from "../src/session/steps.js";

test("étapes : ce que fait chaque outil, en quelques mots", () => {
  assert.equal(stepLabel("WebSearch"), "Recherche web");
  assert.equal(stepLabel("mcp__kopilia__ask_agent"), "Agent dépêché");
  assert.equal(stepLabel("mcp__kopilia__economic_calendar"), "Calendrier éco");
  assert.equal(stepLabel("mcp__kopilia__market_price"), "Cours en direct");
  assert.equal(stepLabel("mcp__kopilia__market_history"), "Historique des cours", "même étape pour un agent");
  assert.equal(stepLabel("mcp__kopilia__search_conversations"), "Conversations passées");
  assert.equal(stepLabel("mcp__kopilia__skill_view"), "Recette");
  assert.equal(stepLabel("mcp__kopilia__learn_from_conversation"), "Apprentissage");
  assert.equal(stepLabel("ToolSearch"), undefined, "chargement d'un outil par le CLI : pas une étape");
  assert.equal(stepLabel("mcp__claude-in-chrome__navigate"), "navigate", "outil inconnu : son nom court");
  assert.equal(stepLabel("some_tool"), "some tool");
});
