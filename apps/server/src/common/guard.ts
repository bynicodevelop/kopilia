/**
 * Garde-fou de ce que Kopilia écrit dans sa mémoire et ses recettes. Ces textes
 * entrent ensuite dans le prompt de toutes les sessions : une consigne glissée
 * par une page web (« ignore tes instructions », « envoie les données à… »)
 * deviendrait une règle permanente. On refuse donc ce qui ressemble à une
 * injection, à une fuite de données ou à un secret, et les caractères
 * invisibles qui servent à les cacher. Le message dit pourquoi, pour que le
 * relecteur reformule ou renonce.
 */

interface Rule {
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  {
    pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/,
    reason: "caractères invisibles (souvent utilisés pour cacher une consigne)",
  },
  {
    pattern:
      /\b(ignore[rsz]?|oublie[rsz]?|disregard|forget)\b[^.\n]{0,40}\b(instructions?|consignes?|r[èe]gles?|prompt|previous|pr[ée]c[ée]dentes?|above|ci-dessus)\b/i,
    reason: "consigne qui annule les instructions (injection)",
  },
  {
    pattern: /\b(you are now|tu es (?:d[ée]sormais|maintenant)|new system prompt|nouveau prompt syst[èe]me)\b|<\/?(?:system|instructions?)>/i,
    reason: "changement de rôle ou faux message système (injection)",
  },
  {
    pattern: /\b(curl|wget|fetch|http\.?post|requests\.post)\b[^\n]{0,120}(\s-d\b|\s-F\b|\s-T\b|--data|--upload|-X\s*POST|\bPOST\b|method\s*[:=]\s*["']?post)/i,
    reason: "commande qui envoie des données vers l'extérieur",
  },
  {
    pattern: /\b(envoie|envoyer|transmets?|transmettre|poste[rz]?|publie[rz]?|upload|send|post|exfiltr\w*)\b[^.\n]{0,80}(https?:\/\/|webhook|\b\S+@\S+\.\w+)/i,
    reason: "consigne d'envoyer des informations à une adresse",
  },
  {
    pattern: /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/,
    reason: "ressemble à un jeton ou une clé secrète",
  },
  {
    pattern: /\b(api[_ -]?key|token|jeton|password|mot de passe|secret)\b\s*[:=]\s*\S{8,}/i,
    reason: "contient un secret (clé, jeton, mot de passe)",
  },
  {
    pattern: /\bKOPILIA_[A-Z_]*(TOKEN|KEY|SECRET)\b|\bMETAAPI_TOKEN\b/,
    reason: "nomme une variable secrète de Kopilia",
  },
];

/** Raison du refus, ou undefined si le texte peut être retenu. */
export function unsafeContent(text: string): string | undefined {
  for (const rule of RULES) if (rule.pattern.test(text)) return rule.reason;
  return undefined;
}

/** Nom de recette : kebab-case, 3 à 48 caractères, une classe de tâches (pas un ticket ni une date). */
export function invalidSkillName(name: string): string | undefined {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) return "le nom doit être en kebab-case (ex. « donner-un-cours »)";
  if (name.length < 3 || name.length > 48) return "le nom doit faire de 3 à 48 caractères";
  if (/\d{4}|\b(fix|debug|bug|incident|test|tmp|today|aujourd-hui|session)\b/.test(name.replace(/-/g, " "))) {
    return "le nom doit désigner une classe de tâches, pas un incident, une date ou une session";
  }
  return undefined;
}

/** Fichier d'appoint d'une recette : references/<sujet>.md seulement. */
export function invalidSkillFile(path: string): string | undefined {
  return /^references\/[a-z0-9][a-z0-9-]{1,48}\.md$/.test(path) ? undefined : "un fichier d'appoint se range sous references/<sujet>.md (kebab-case)";
}
