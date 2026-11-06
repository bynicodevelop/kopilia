import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBrief } from "../src/app/brief/render";

test("brief : titres, puces, paragraphes et gras", () => {
  const html = renderBrief("## En bref\nLa BCE a **maintenu** ses taux.\n\n## Banques centrales\n- Fed : statu quo\n- BCE : 2 %");
  assert.equal(
    html,
    "<h3>En bref</h3><p>La BCE a <strong>maintenu</strong> ses taux.</p><h3>Banques centrales</h3><ul><li>Fed : statu quo</li><li>BCE : 2 %</li></ul>",
  );
});

test("brief : le HTML venu du web est neutralisé", () => {
  const html = renderBrief('Texte <script>alert(1)</script> <img src=x onerror="y">');
  assert.ok(!html.includes("<script>") && !html.includes("<img"), html);
  assert.match(html, /&lt;script&gt;/);
});

test("brief : seuls les liens http(s) deviennent cliquables", () => {
  const html = renderBrief("- [Communiqué](https://www.ecb.europa.eu/press/pr/x.html) et https://www.bls.gov/cpi\n- [piège](javascript:alert(1))");
  assert.match(html, /<a href="https:\/\/www\.ecb\.europa\.eu\/press\/pr\/x\.html" target="_blank" rel="noopener noreferrer">Communiqué<\/a>/);
  assert.match(html, /<a href="https:\/\/www\.bls\.gov\/cpi"[^>]*>https:\/\/www\.bls\.gov\/cpi<\/a>/);
  assert.ok(!html.includes('href="javascript'), html);
});

test("brief : étiquettes faits / analyses mises en valeur", () => {
  assert.equal(renderBrief("[FAIT] Inflation à 2,4 %"), '<p><span class="lbl">FAIT</span> Inflation à 2,4 %</p>');
});
