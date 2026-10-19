// Läuft LOKAL (nicht in der Action): liest die Claude-Code-Protokolle in ~/.claude/projects und speichert
// nur Zahlen (Token pro Tag und Modell) in tokens.json. Inhalte der Gespräche werden nie gelesen oder gespeichert.
// Claude Code löscht alte Protokolle automatisch, deshalb wird über die Zeit aufsummiert.
//
// Nutzung:  node track-tokens.mjs           (nur tokens.json aktualisieren)
//           node track-tokens.mjs --push    (zusätzlich committen und pushen)
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
const FILE = process.env.TOKENS_FILE || join(HERE, 'tokens.json');
const TZ = process.env.STATS_TZ || 'Europe/Berlin';
const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.jsonl')) files.push(p);
  }
})(ROOT);

// pro Tag und Modell: i = input, o = output, cw = cache write, cr = cache read, n = Antworten
const scan = {};
const seen = new Set();
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const u = o.message?.usage;
    if (o.type !== 'assistant' || !u || !o.timestamp) continue;
    const key = `${o.message.id || ''}:${o.requestId || ''}`; // Streaming schreibt dieselbe Antwort mehrfach
    if (key !== ':') { if (seen.has(key)) continue; seen.add(key); }
    const day = dayOf.format(new Date(o.timestamp));
    const m = (scan[day] ||= {})[o.message.model || 'unknown'] ||= { i: 0, o: 0, cw: 0, cr: 0, n: 0 };
    m.i += u.input_tokens || 0;
    m.o += u.output_tokens || 0;
    m.cw += u.cache_creation_input_tokens || 0;
    m.cr += u.cache_read_input_tokens || 0;
    m.n++;
  }
}

// Mit dem Bestand zusammenführen: pro Feld gewinnt der größere Wert (gelöschte Protokolle dürfen nichts abziehen)
const hist = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { days: {} };
for (const [day, models] of Object.entries(scan)) {
  for (const [model, v] of Object.entries(models)) {
    const cur = ((hist.days[day] ||= {})[model] ||= { i: 0, o: 0, cw: 0, cr: 0, n: 0 });
    for (const k of Object.keys(v)) cur[k] = Math.max(cur[k] || 0, v[k]);
  }
}
const before = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
const out = JSON.stringify({ days: hist.days });
if (out !== before) writeFileSync(FILE, out);

let total = 0;
for (const models of Object.values(hist.days)) for (const v of Object.values(models)) total += v.i + v.o + v.cw + v.cr;
console.log(`${files.length} Protokolle, ${Object.keys(hist.days).length} Tage, ${total.toLocaleString('de-DE')} Token insgesamt`);

if (process.argv.includes('--push') && out !== before) {
  const git = (...a) => execFileSync('git', a, { cwd: HERE, stdio: 'pipe' }).toString();
  git('pull', '--rebase', '--autostash');
  git('add', 'tokens.json');
  git('-c', 'user.name=Nicolas Kunze', '-c', 'user.email=nkunze923@gmail.com', 'commit', '-m', 'chore: update token usage');
  git('push');
  console.log('gepusht');
}
