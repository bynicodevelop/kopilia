// Le journal de trading à l'écran, sans écran : les R, les couleurs d'un résultat, les mots du fil.
process.env.TZ = "Europe/Paris";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JournalLine } from "@kopilia/contracts";
import { durationText, itemLabel, lineDetail, outcomeText, rText, tone } from "../src/app/journal/journal-view";

test("journal à l'écran : R signés à la française, couleur du résultat, détail d'une ligne, mots du fil", () => {
  assert.equal(rText(2), "+2 R");
  assert.equal(rText(-1.034), "−1,03 R");
  assert.equal(rText(0), "0 R");
  assert.equal(tone("win"), "up");
  assert.equal(tone("loss"), "down");
  assert.equal(tone("neutral"), "flat");
  assert.equal(tone(undefined), "flat");
  assert.equal(outcomeText("neutral"), "neutre");
  const line = { remark: "à l'objectif", note: "plan respecté" } as JournalLine;
  assert.equal(lineDetail(line), "à l'objectif · « plan respecté »");
  assert.equal(lineDetail({} as JournalLine), "");
  assert.equal(itemLabel({ at: 1, kind: "challenge", by: "kopilia", text: "x" }), "Contradicteur");
  assert.equal(itemLabel({ at: 1, kind: "note", by: "user", text: "x" }), "Ta note");
  assert.equal(durationText(124 * 60_000), "2 h 04");
});

test("calendrier du journal : les semaines du lundi au vendredi, le week-end compté dans sa semaine, la teinte d'un jour", async () => {
  const { monthGrid, dayTint } = await import("../src/app/journal/journal-view");
  const weeks = monthGrid("2026-11", [
    { date: "2026-11-03", count: 1, r: 0.7 },
    { date: "2026-11-05", count: 2, r: -1.03 },
    { date: "2026-11-08", count: 1, r: 0.5 },
    { date: "2026-11-30", count: 1, r: 1 },
  ]);
  // Novembre 2026 : le 1er est un dimanche ; la semaine du 26 octobre, sans jour de bourse du mois ni trade, n'y est pas.
  assert.equal(weeks[0].cells[0].date, "2026-11-02");
  assert.equal(weeks[0].cells.length, 5);
  assert.equal(weeks[0].cells[1].r, 0.7);
  assert.equal(weeks[0].count, 4, "le dimanche 8 compte dans la semaine du 2");
  assert.equal(weeks[0].r, 0.17);
  assert.equal(weeks.at(-1)!.cells[0].date, "2026-11-30");
  assert.equal(weeks.at(-1)!.cells[1].inMonth, false, "le 1er décembre");
  assert.equal(weeks.length, 5);
  // Un trade fermé le dimanche 1er novembre garde sa semaine.
  assert.equal(monthGrid("2026-11", [{ date: "2026-11-01", count: 1, r: 1 }])[0].cells[0].date, "2026-10-26");
  assert.equal(dayTint(0, 0), null);
  assert.equal(dayTint(0.05, 1), null, "neutre : pas de teinte");
  assert.equal(dayTint(2, 1), "color-mix(in srgb, var(--accent-2) 15%, transparent)");
  assert.equal(dayTint(-1, 1), "color-mix(in srgb, var(--danger) 10%, transparent)");
});
