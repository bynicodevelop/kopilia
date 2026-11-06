#!/usr/bin/env node
/**
 * Double déterministe du CLI `claude` en mode stream-json bidirectionnel.
 * Sert aux tests du serveur et à la recette hors authentification.
 *
 * - émet un événement system/init avec un session_id (ou le reprend via --resume)
 * - pour chaque ligne user, diffuse des deltas puis un result
 * - mémoire minimale : retient « le nom de code ... est X » et le restitue
 *   (permet de valider le rappel « Atlas » de la recette étape 2)
 */
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const sessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : `mock-${randomUUID()}`;
const systemIdx = args.indexOf("--system-prompt");
const systemPrompt = systemIdx >= 0 ? args[systemIdx + 1] : "";
/** Dossiers lisibles en plus du dossier courant (documents joints d'un agent, calendrier). */
// Ligne de commande reçue, pour les tests (KOPILIA_MOCK_ARGV_LOG) : aucun secret ne doit y figurer.
if (process.env.KOPILIA_MOCK_ARGV_LOG) appendFileSync(process.env.KOPILIA_MOCK_ARGV_LOG, JSON.stringify(args) + "\n");
const addDirs = args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []));
/** Liste d'une option variadique (--allowedTools a b c) : jusqu'à l'option suivante. */
function listAfter(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const rest = args.slice(i + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
}
/** Serveurs MCP reçus, avec les NOMS de leurs variables (jamais les valeurs). */
const mcpServers = listAfter("--mcp-config").flatMap((arg) => {
  try {
    // Le vrai CLI accepte un fichier ou du JSON ; Kopilia passe un fichier (les jetons n'apparaissent pas dans ps).
    const json = existsSync(arg) ? readFileSync(arg, "utf8") : arg;
    return Object.entries(JSON.parse(json).mcpServers ?? {}).map(([name, s]) => `${name} (${Object.keys(s.env ?? {}).join(", ")})`);
  } catch {
    return [];
  }
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

emit({ type: "system", subtype: "init", session_id: sessionId });

let codeName = null;

const MOCK_BRIEF = [
  "# Wrap de test : la BCE maintient ses taux",
  "Séances couvertes : Europe du jour de test.",
  "",
  "## En bref",
  "La BCE a maintenu ses taux. L'inflation américaine ralentit.",
  "",
  "## Titres",
  "- BCE : taux de dépôt inchangé ([communiqué](https://www.ecb.europa.eu/press/pr/test.html))",
  "",
  "## Sources",
  "- https://www.ecb.europa.eu/press/pr/test.html",
].join("\n");

function replyFor(text) {
  const set = text.match(/nom de code\s+(?:du projet\s+)?(?:est|:)\s+([\p{L}\p{N}-]+)/iu);
  if (set) {
    codeName = set[1];
    return `Compris, le nom de code est ${codeName}.`;
  }
  if (/nom de code/i.test(text)) {
    return codeName ? `${codeName}.` : "Aucun nom de code ne m'a été donné.";
  }
  return `Bien reçu : ${text.slice(0, 80)}`;
}

function streamText(text) {
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: word } }, session_id: sessionId });
  }
  // Fin du bloc de texte (le vrai CLI l'émet aussi).
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sessionId });
}

/**
 * Un appel d'outil, comme le vrai CLI : début du bloc tool_use dans le flux,
 * message assistant complet (avec ce que vise l'outil), puis le résultat
 * renvoyé au modèle (`error` : l'outil a échoué).
 */
function toolUse(name, input = {}, error = null) {
  const id = `toolu_${randomUUID()}`;
  emit({
    type: "stream_event",
    event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name, input: {} } },
    session_id: sessionId,
  });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 1 }, session_id: sessionId });
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, session_id: sessionId });
  emit({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: !!error, content: error ?? "ok" }] },
    session_id: sessionId,
  });
}

function finish(text) {
  emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId });
}

function streamReply(text) {
  streamText(text);
  finish(text);
}

/** Réponse différée en cours (crochets [lent] / [outil]), annulable par interrupt. */
let pending = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Protocole de contrôle (comme le vrai CLI / Agent SDK) : interrupt arrête le tour.
  if (msg.type === "control_request") {
    emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
    if (msg.request?.subtype === "interrupt" && pending) {
      clearTimeout(pending);
      pending = null;
      emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: sessionId });
    }
    return;
  }

  const content = msg?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : "";

  // Crochets de test :
  //  [lent]    -> réponse tardive (déclenche le filler serveur, couche 1)
  //  [outil]   -> préambule SANS ponctuation, appel d'outil simulé, puis réponse (couche 2)
  //  [système] -> restitue le début du prompt système reçu (date, souvenirs)
  //  « brief de veille » -> rédige un brief type (agent de veille)
  //  [agenda]  -> réponse écrite avec heures, sigle et émoji (transcription pour l'oral)
  //  [dossiers] -> les dossiers lisibles (--add-dir) et les documents listés dans l'invite (agent)
  //  [outils]  -> les outils autorisés et les serveurs MCP reçus (noms de variables seulement)
  //  [trace]   -> une page qui échoue, puis curl qui réussit (trace d'un agent)
  //  documents joints -> leurs noms et les blocs reçus (PDF, image)
  if (text.includes("[outils]")) {
    streamReply(`Outils : ${listAfter("--allowedTools").join(" ") || "aucun"}.\nServeurs MCP : ${mcpServers.join(" ; ") || "aucun"}.`);
    return;
  }
  if (text.includes("[trace]")) {
    toolUse("WebFetch", { url: "https://cinema.example/horaires", prompt: "séances" }, "Request failed with status code 403");
    toolUse("Bash", { command: "curl -sL https://cinema.example/horaires" });
    streamReply("Séances trouvées par curl.");
    return;
  }
  if (text.includes("[dossiers]")) {
    const listed = text.split("\n").filter((l) => l.startsWith("- "));
    streamReply(`Dossiers lus : ${addDirs.join(" ; ") || "aucun"}.\n${listed.join("\n")}`);
    return;
  }
  const joined = [...text.matchAll(/\[Document joint[^«]*« ([^»]+) »/g)].map((m) => m[1]);
  if (joined.length) {
    const blocks = Array.isArray(content) ? content.filter((c) => c.type !== "text").map((c) => c.type) : [];
    streamReply(`Documents reçus : ${joined.join(", ")} ; blocs : ${blocks.join(", ") || "aucun"}.`);
    return;
  }
  if (text.includes("[agenda]")) {
    streamReply("L'ISM sort à 16h et le NFP vendredi à 14:30. Bonne journée ! 🙂");
    return;
  }
  if (text.includes("[système]")) {
    streamReply(systemPrompt.slice(0, 600) || "Aucun prompt système.");
    return;
  }
  if (/brief de veille/i.test(text) && !text.includes("[Résultat d'agent]")) {
    streamReply(MOCK_BRIEF);
    return;
  }
  if (text.includes("[lent]")) {
    const reply = replyFor(text.replace("[lent]", "").trim());
    pending = setTimeout(() => {
      pending = null;
      streamReply(reply);
    }, 1200);
    return;
  }
  //  [étapes N] -> N appels d'outils espacés (recherche web, lecture…), puis la réponse
  const steps = text.match(/\[étapes (\d+)\]/);
  if (steps) {
    const tools = ["WebSearch", "WebFetch", "Read", "Grep", "WebSearch"];
    let n = 0;
    const next = () => {
      if (n >= Number(steps[1])) {
        pending = null;
        streamReply(`Terminé en ${n} étapes.`);
        return;
      }
      toolUse(tools[n++ % tools.length]);
      pending = setTimeout(next, 700);
    };
    pending = setTimeout(next, 300);
    return;
  }
  if (text.includes("[outil]")) {
    streamText("Je regarde la météo");
    toolUse("WebSearch");
    pending = setTimeout(() => {
      pending = null;
      const answer = "Il fait beau à Paris.";
      streamText(answer);
      finish(`Je regarde la météo\n${answer}`);
    }, 400);
    return;
  }
  streamReply(replyFor(text));
});
