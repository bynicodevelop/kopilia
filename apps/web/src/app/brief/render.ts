/**
 * Rendu HTML d'un brief de veille (sous-ensemble de Markdown : titres, puces,
 * paragraphes, gras, liens, étiquettes [FAIT]/[ANALYSE]). Le texte vient d'un
 * agent qui a lu le web : tout est échappé d'abord, et seuls les liens http(s)
 * deviennent cliquables.
 */
export function renderBrief(markdown: string): string {
  let html = "";
  let para: string[] = [];
  let inList = false;
  const flushPara = () => {
    if (para.length) html += `<p>${inline(para.join(" "))}</p>`;
    para = [];
  };
  const closeList = () => {
    if (inList) html += "</ul>";
    inList = false;
  };

  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length + 1, 4); // le titre du brief est déjà affiché au-dessus
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      continue;
    }
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      if (!inList) html += "<ul>";
      inList = true;
      html += `<li>${inline(item[1])}</li>`;
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function link(url: string, text: string): string {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => link(url, text))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) => pre + link(url, url))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[(FAIT|ANALYSE)\]/g, '<span class="lbl">$1</span>');
}

/** Le titre d'un brief est affiché à part : la ligne « # … » qui l'ouvre est retirée du texte. */
export function stripBriefTitle(content: string): string {
  return content.replace(/^#\s+.*(\n|$)/, "");
}
