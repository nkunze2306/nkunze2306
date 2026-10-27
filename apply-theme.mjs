// Läuft im Workflow apply-theme.yml: liest die Einstellungen aus dem Issue-Text (ISSUE_BODY),
// prüft sie mit normalizeTheme und schreibt theme.json. Exit-Code 2, wenn kein gültiges JSON im Text steht.
import { writeFileSync } from 'node:fs';
import { normalizeTheme } from './theme.mjs';

const body = process.env.ISSUE_BODY || '';
const m = body.match(/```(?:json)?\s*([\s\S]*?)```/);
let raw;
try { raw = JSON.parse(m ? m[1] : body); } catch { console.error('Kein gültiges JSON im Issue gefunden'); process.exit(2); }

const theme = normalizeTheme(raw);
writeFileSync(process.env.THEME_FILE || 'theme.json', JSON.stringify(theme, null, 2) + '\n');
console.log(JSON.stringify(theme));
