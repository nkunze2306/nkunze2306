// Erzeugt stats.svg + stats.json aus den GitHub-Daten des Profils.
// Nutzung:  node generate.mjs          (echte Daten, braucht STATS_TOKEN + STATS_LOGIN)
//           node generate.mjs --demo   (Dummy-Daten zum Design-Check)
import { writeFileSync } from 'node:fs';

const TOKEN = (process.env.STATS_TOKEN || process.env.GITHUB_TOKEN || '').trim() || undefined;
const LOGIN = process.env.STATS_LOGIN || process.env.GITHUB_REPOSITORY_OWNER;
const TZ = process.env.STATS_TZ || 'Europe/Berlin';
const MAX_PAGES = Number(process.env.STATS_MAX_PAGES || 50); // 100 Commits pro Seite, Branch und Repo
const OUT = process.env.STATS_OUT || 'stats.svg';
const OUT_JSON = process.env.STATS_JSON || 'stats.json';
const AI_RE =
  /co-authored-by:[^\n]*(claude|anthropic|copilot|chatgpt|openai|codex|gemini|cursor|aider|devin)|generated with \[?claude/i;

// ---------------------------------------------------------------- Daten holen

async function api(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', ...init.headers } });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

async function gql(query, variables = {}) {
  const json = await api('https://api.github.com/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const REPO_FIELDS = `nameWithOwner isPrivate isFork stargazerCount forkCount watchers{totalCount}
  languages(first:10,orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } }`;

async function fetchData() {
  if (!TOKEN || !LOGIN) throw new Error('STATS_TOKEN (oder GITHUB_TOKEN) und STATS_LOGIN fehlen');

  const rest = await api(`https://api.github.com/users/${LOGIN}`); // followers/following stimmen hier zuverlässig
  const { user: u } = await gql(
    `query($login:String!){ user(login:$login){
      id login name createdAt
      organizations{totalCount} gists{totalCount} starredRepositories{totalCount}
      pullRequests{totalCount} mergedPRs: pullRequests(states:MERGED){totalCount}
      issues{totalCount} closedIssues: issues(states:CLOSED){totalCount}
      ownRepos: repositories(ownerAffiliations:OWNER){totalCount}
      forkedRepos: repositories(ownerAffiliations:OWNER,isFork:true){totalCount}
      repositoriesContributedTo(contributionTypes:[COMMIT,PULL_REQUEST,REPOSITORY]){totalCount}
      contributionsCollection{ contributionCalendar{ weeks{ contributionDays{ date contributionCount } } } }
    } }`,
    { login: LOGIN },
  );

  // Reviews: Maximum aus Suche und Contribution-Zählern (beide können Lücken haben)
  const now = new Date();
  const startYear = new Date(u.createdAt).getUTCFullYear();
  let yq = 'query($login:String!){ user(login:$login){';
  for (let y = startYear; y <= now.getUTCFullYear(); y++) {
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    yq += `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${to}"){ totalPullRequestReviewContributions }`;
  }
  yq += '} }';
  const reviewsContrib = Object.values((await gql(yq, { login: LOGIN })).user).reduce((s, y) => s + y.totalPullRequestReviewContributions, 0);
  const reviewsSearch = (await gql(`query($q:String!){ search(query:$q,type:ISSUE,first:1){ issueCount } }`, { q: `type:pr reviewed-by:${LOGIN}` })).search.issueCount;
  const reviews = Math.max(reviewsContrib, reviewsSearch);

  // Alle Repos: eigene, Forks, Orgs, Kollaborationen und alles, wozu beigetragen wurde
  const repoMap = new Map();
  for (let after = null, more = true; more; ) {
    const d = await gql(
      `query($login:String!,$after:String){ user(login:$login){
        repositories(affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],first:100,after:$after){
          pageInfo{hasNextPage endCursor} nodes{ ${REPO_FIELDS} } } } }`,
      { login: LOGIN, after },
    );
    d.user.repositories.nodes.forEach((r) => repoMap.set(r.nameWithOwner, r));
    more = d.user.repositories.pageInfo.hasNextPage;
    after = d.user.repositories.pageInfo.endCursor;
  }
  for (let after = null, more = true; more; ) {
    const d = await gql(
      `query($login:String!,$after:String){ user(login:$login){
        repositoriesContributedTo(first:100,after:$after,contributionTypes:[COMMIT,PULL_REQUEST,REPOSITORY]){
          pageInfo{hasNextPage endCursor} nodes{ ${REPO_FIELDS} } } } }`,
      { login: LOGIN, after },
    );
    d.user.repositoriesContributedTo.nodes.forEach((r) => repoMap.set(r.nameWithOwner, r));
    more = d.user.repositoriesContributedTo.pageInfo.hasNextPage;
    after = d.user.repositoriesContributedTo.pageInfo.endCursor;
  }
  const repos = [...repoMap.values()].sort((a, b) => Number(a.isFork) - Number(b.isFork)); // Originale zuerst -> Forks zählen nicht doppelt

  // Commit-Historie aller Branches, dedupliziert über die Commit-ID
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  });
  const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const monthKeys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en', { month: 'short' }),
      name: d.toLocaleString('en', { month: 'long', year: 'numeric' }),
    });
  }
  const monthly = new Map(monthKeys.map((m) => [m.key, { label: m.label, name: m.name, human: 0, ai: 0 }]));
  const weekday = Array(7).fill(0);
  const hours = Array(24).fill(0);
  const daily = new Map();
  const repoCount = new Map();
  const seen = new Set();
  const yearAgo = now.getTime() - 365 * 864e5;
  let commitsYear = 0, addHuman = 0, addAI = 0, del = 0;

  for (const r of repos) {
    const [owner, name] = r.nameWithOwner.split('/');
    try {
      const branches = [];
      for (let after = null, p = 0; p < 4; p++) {
        const b = (await gql(
          `query($owner:String!,$name:String!,$after:String){ repository(owner:$owner,name:$name){
            refs(refPrefix:"refs/heads/",first:50,after:$after){ pageInfo{hasNextPage endCursor} nodes{ name } } } }`,
          { owner, name, after },
        )).repository?.refs;
        if (!b) break;
        branches.push(...b.nodes.map((n) => n.name));
        if (!b.pageInfo.hasNextPage) break;
        after = b.pageInfo.endCursor;
      }
      for (const br of branches) {
        let after = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          const h = (await gql(
            `query($owner:String!,$name:String!,$ref:String!,$id:ID!,$after:String){ repository(owner:$owner,name:$name){
              ref(qualifiedName:$ref){ target{ ... on Commit{ history(first:100,after:$after,author:{id:$id}){
                pageInfo{hasNextPage endCursor} nodes{ oid committedDate additions deletions message } } } } } } }`,
            { owner, name, ref: `refs/heads/${br}`, id: u.id, after },
          )).repository?.ref?.target?.history;
          if (!h) break;
          for (const c of h.nodes) {
            if (seen.has(c.oid)) continue;
            seen.add(c.oid);
            const ai = AI_RE.test(c.message);
            const date = new Date(c.committedDate);
            const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
            const m = monthly.get(`${p.year}-${p.month}`);
            if (m) m[ai ? 'ai' : 'human']++;
            const day = `${p.year}-${p.month}-${p.day}`;
            daily.set(day, (daily.get(day) || 0) + 1);
            weekday[WD[p.weekday]]++;
            hours[Number(p.hour)]++;
            repoCount.set(r.nameWithOwner, (repoCount.get(r.nameWithOwner) || 0) + 1);
            if (date.getTime() >= yearAgo) commitsYear++;
            if (ai) addAI += c.additions; else addHuman += c.additions;
            del += c.deletions;
          }
          if (!h.pageInfo.hasNextPage) break;
          after = h.pageInfo.endCursor;
        }
      }
    } catch (e) {
      console.warn(`übersprungen: ${r.nameWithOwner}: ${e.message.slice(0, 160)}`);
    }
  }

  // Heatmap: pro Tag das Maximum aus GitHubs Calendar (inkl. PRs/Issues/Reviews) und den eigenen Commits
  const weeks = u.contributionsCollection.contributionCalendar.weeks.map((w) =>
    w.contributionDays.map((d) => ({ date: d.date, count: Math.max(d.contributionCount, daily.get(d.date) || 0) })),
  );
  const contribYear = weeks.flat().reduce((s, d) => s + d.count, 0);
  const commitsAll = seen.size;

  // Sprachen, Sterne, Forks nur aus Repos mit eigener Aktivität bzw. eigenen Originalen
  const owned = repos.filter((r) => r.nameWithOwner.startsWith(`${LOGIN}/`) && !r.isFork);
  const langMap = new Map();
  for (const r of repos.filter((x) => repoCount.has(x.nameWithOwner)))
    for (const e of r.languages.edges) {
      const l = langMap.get(e.node.name) || { name: e.node.name, color: e.node.color || '#888', size: 0 };
      l.size += e.size;
      langMap.set(e.node.name, l);
    }

  let n = 0; // private Repos nie namentlich anzeigen
  const privateOf = new Map(repos.map((r) => [r.nameWithOwner, r.isPrivate]));
  const topRepos = [...repoCount].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([full, count]) => ({ name: privateOf.get(full) ? `private repo ${++n}` : full.split('/')[1], count }));

  return {
    login: u.login, name: u.name || u.login, joined: startYear,
    followers: rest.followers, following: rest.following,
    orgs: u.organizations.totalCount, gists: u.gists.totalCount, starred: u.starredRepositories.totalCount,
    commitsAll, commitsYear,
    totalContribAll: commitsAll + u.pullRequests.totalCount + u.issues.totalCount + reviews, contribYear,
    weeks,
    pr: { total: u.pullRequests.totalCount, merged: u.mergedPRs.totalCount },
    issues: { total: u.issues.totalCount, closed: u.closedIssues.totalCount },
    reviews,
    stars: owned.reduce((s, r) => s + r.stargazerCount, 0),
    forks: u.forkedRepos.totalCount,
    forksReceived: owned.reduce((s, r) => s + r.forkCount, 0),
    watchers: owned.reduce((s, r) => s + r.watchers.totalCount, 0),
    reposOwn: u.ownRepos.totalCount, reposContrib: u.repositoriesContributedTo.totalCount,
    addHuman, addAI, del,
    languages: [...langMap.values()].sort((a, b) => b.size - a.size),
    monthly: [...monthly.values()],
    topRepos, weekday, hours, updated: now,
  };
}

function demoData() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const weeks = [];
  const start = new Date('2025-10-19T00:00:00Z');
  for (let w = 0; w < 53; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getTime() + (w * 7 + d) * 864e5);
      if (date > new Date('2026-10-19T00:00:00Z')) break;
      week.push({ date: date.toISOString().slice(0, 10), count: rnd() < 0.35 ? 0 : Math.floor(rnd() * rnd() * 14) });
    }
    weeks.push(week);
  }
  const human = [30, 24, 40, 52, 44, 50, 34, 28, 45, 38, 60, 42];
  const ai = [0, 0, 4, 12, 10, 18, 16, 10, 20, 26, 38, 14];
  const labels = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
  return {
    login: 'username', name: 'Nicolas', joined: 2021,
    followers: 64, following: 48, orgs: 2, gists: 5, starred: 203,
    commitsAll: 2847, commitsYear: 2009, totalContribAll: 3141, contribYear: 2151,
    weeks,
    pr: { total: 143, merged: 121 }, issues: { total: 62, closed: 55 }, reviews: 89, stars: 318,
    forks: 41, forksReceived: 12, watchers: 22, reposOwn: 27, reposContrib: 14,
    addHuman: 136000, addAI: 48000, del: 61000,
    languages: [
      { name: 'TypeScript', color: '#38bdf8', size: 31 }, { name: 'Python', color: '#b794ff', size: 24 },
      { name: 'C#', color: '#34f5a0', size: 18 }, { name: 'JavaScript', color: '#fbbf24', size: 11 },
      { name: 'HTML', color: '#ff5c9a', size: 9 }, { name: 'CSS', color: '#6b8afd', size: 7 },
    ],
    monthly: labels.map((label, i) => ({ label, name: label, human: human[i], ai: ai[i] })),
    topRepos: [
      { name: 'portfolio', count: 612 }, { name: 'game-prototype', count: 548 },
      { name: 'dotfiles', count: 301 }, { name: 'uni-notes', count: 190 }, { name: 'private repo 1', count: 120 },
    ],
    weekday: [40, 62, 44, 48, 46, 28, 32],
    hours: [30, 22, 12, 6, 4, 3, 5, 9, 16, 24, 32, 38, 48, 52, 44, 40, 46, 42, 38, 50, 58, 66, 92, 30],
    updated: new Date('2026-10-19T12:00:00Z'),
  };
}

// ---------------------------------------------------------------- Rendern

const C = { card: '#121212', line: '#262626', text: '#ffffff', mute: '#9a9a9a', dim: '#6a6a6a', track: '#2a2a2a', bar: '#2f3340',
  green: '#34f5a0', purple: '#b794ff', blue: '#38bdf8', pink: '#ff5c9a', yellow: '#fbbf24' };
const W = 720, M = 1, G = 12, CW = W - 2 * M, PAD = 22;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => Math.round(n).toLocaleString('de-DE');
const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2).replace(/.?0+$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
// fast schwarze Sprachfarben (z. B. ShaderLab) sind auf dunklem Grund unsichtbar
const vivid = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 90 ? '#8b949e' : hex; };
const text = (x, y, s, { size = 12, fill = C.mute, weight = 400, anchor = 'start', ls = 0 } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}"${ls ? ` letter-spacing="${ls}"` : ''}>${esc(s)}</text>`;
// mehrere Textstücke in einer Zeile, Abstände regelt der Browser
const line = (x, y, spans, anchor = 'start') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}">${spans.map(([s, o = {}]) =>
    `<tspan font-size="${o.size || 12}" font-weight="${o.weight || 400}" fill="${o.fill || C.mute}"${o.dx ? ` dx="${o.dx}"` : ''}>${esc(s)}</tspan>`).join('')}</text>`;

function card(x, y, w, h, title, color, right = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${C.card}" stroke="${C.line}"/>
<circle cx="${x + PAD + 5}" cy="${y + 26}" r="11" fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-opacity="0.55"/>
<circle cx="${x + PAD + 5}" cy="${y + 26}" r="3.2" fill="${color}"/>
${text(x + PAD + 24, y + 30, title.toUpperCase(), { size: 11, weight: 700, ls: 1.1 })}${right ? text(x + w - PAD, y + 30, right, { size: 12, anchor: 'end' }) : ''}`;
}

const bar = (x, y, w, h, ratio, color) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.track}"/>` +
  (ratio > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(h, w * Math.min(ratio, 1))}" height="${h}" rx="${h / 2}" fill="${color}"/>` : '');

function rowX(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const avail = CW - G * (weights.length - 1);
  let x = M;
  return weights.map((wt) => {
    const w = (avail * wt) / total;
    const r = { x, w };
    x += w + G;
    return r;
  });
}

function streaks(weeks) {
  const days = weeks.flat();
  let longest = 0, run = 0, best = 0, active = 0;
  for (const d of days) {
    if (d.count > 0) { run++; active++; longest = Math.max(longest, run); best = Math.max(best, d.count); } else run = 0;
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) current++;
    else if (i === days.length - 1) continue; // heute noch nichts -> Streak lebt noch
    else break;
  }
  return { current, longest, active, best };
}

// Säulendiagramm mit Zahl über jeder Säule. items: [{value, label, color, strong?}]
function columns(parts, x, y, w, h, items, { labelSize = 10.5, valueSize = 10.5, gap = 0.22 } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const slot = w / items.length, bw = slot * (1 - gap);
  items.forEach((it, i) => {
    const bx = x + i * slot + (slot - bw) / 2;
    const hh = Math.max(3, (it.value / max) * h);
    parts.push(`<rect x="${bx.toFixed(1)}" y="${(y + h - hh).toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="3" fill="${it.color}"/>`);
    parts.push(text((bx + bw / 2).toFixed(1), (y + h - hh - 6).toFixed(1), num(it.value), { size: valueSize, fill: it.strong ? C.text : C.mute, weight: it.strong ? 700 : 400, anchor: 'middle' }));
    if (it.label) parts.push(text((bx + bw / 2).toFixed(1), y + h + 16, it.label, { size: labelSize, fill: C.dim, anchor: 'middle' }));
  });
}

function render(d) {
  const parts = [];
  let y = M + 4;
  const dateStr = new Date(d.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const add = d.addHuman + d.addAI, net = add - d.del, hr = add ? d.addHuman / add : 1;

  // Header
  const pills = [[d.followers, 'followers'], [d.following, 'following'], [d.orgs, 'orgs'], [d.gists, 'gists'], [d.starred, 'starred']];
  parts.push(`<circle cx="${M + 28}" cy="${y + 30}" r="24" fill="#0f1f18" stroke="${C.green}" stroke-width="1.6"/>`);
  parts.push(text(M + 28, y + 38, d.name[0].toUpperCase(), { size: 23, fill: C.green, weight: 700, anchor: 'middle' }));
  parts.push(text(M + 68, y + 28, d.name, { size: 20, fill: C.text, weight: 700 }));
  parts.push(text(M + 68, y + 47, `@${d.login} · joined ${d.joined}`, { size: 12, fill: C.dim }));
  let px = W - M;
  for (const [n, l] of [...pills].reverse()) {
    const w = (String(num(n)).length + l.length + 1) * 6.9 + 28;
    px -= w;
    parts.push(`<rect x="${px}" y="${y + 14}" width="${w}" height="32" rx="16" fill="#151515" stroke="#2c2c2c"/>`);
    parts.push(`<text x="${px + 14}" y="${y + 34}" font-size="12.5"><tspan fill="#fff" font-weight="700">${esc(num(n))}</tspan><tspan fill="${C.mute}"> ${l}</tspan></text>`);
    px -= 8;
  }
  y += 70;

  // Commits + Heatmap
  const [a, b] = rowX([32, 68]);
  const st = streaks(d.weeks);
  const H1 = 214;
  parts.push(card(a.x, y, a.w, H1, 'Commits · all-time', C.green));
  parts.push(text(a.x + PAD, y + 106, num(d.commitsAll), { size: 62, fill: C.text, weight: 800 }));
  parts.push(text(a.x + PAD, y + 132, `${num(d.commitsYear)} in the last 12 months`, { size: 12.5 }));
  parts.push(`<line x1="${a.x + PAD}" x2="${a.x + a.w - PAD}" y1="${y + 156}" y2="${y + 156}" stroke="${C.line}"/>`);
  parts.push(text(a.x + PAD, y + 188, 'Total contributions', { size: 12.5 }));
  parts.push(text(a.x + a.w - PAD, y + 190, num(d.totalContribAll), { size: 24, fill: C.text, weight: 700, anchor: 'end' }));

  parts.push(card(b.x, y, b.w, H1, `${num(d.contribYear)} contributions in the last year`, C.purple));
  const lv = ['#1f2523', '#0e4f35', '#12804f', '#1fb870', C.green];
  const lgx = b.x + b.w - PAD;
  parts.push(text(lgx - 5 * 11 - 42, y + 30, 'Less', { size: 10.5, anchor: 'end' }));
  lv.forEach((c, i) => parts.push(`<rect x="${lgx - 5 * 11 - 34 + i * 11}" y="${y + 21}" width="9" height="9" rx="2" fill="${c}"/>`));
  parts.push(text(lgx, y + 30, 'More', { size: 10.5, anchor: 'end' }));
  const hx = b.x + PAD, hy = y + 50, pitch = (b.w - 2 * PAD) / 53, cell = pitch - 2;
  const max = Math.max(1, ...d.weeks.flat().map((x) => x.count));
  const monthSum = new Map();
  d.weeks.flat().forEach((x) => monthSum.set(x.date.slice(0, 7), (monthSum.get(x.date.slice(0, 7)) || 0) + x.count));
  const monthLbls = [];
  let lastMonth = -1;
  d.weeks.forEach((week, wi) => {
    week.forEach((day) => {
      const dow = new Date(day.date + 'T00:00:00Z').getUTCDay();
      const l = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / max) * 4));
      parts.push(`<rect x="${(hx + wi * pitch).toFixed(1)}" y="${(hy + dow * pitch).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="1.8" fill="${lv[l]}"/>`);
    });
    const m = new Date(week[0].date + 'T00:00:00Z').getUTCMonth();
    if (m !== lastMonth) {
      if (lastMonth !== -1) {
        const lx = (hx + wi * pitch).toFixed(1);
        monthLbls.push(text(lx, hy + 7 * pitch + 14, new Date(Date.UTC(2000, m, 1)).toLocaleString('en', { month: 'short' }), { size: 10, fill: C.mute }));
        monthLbls.push(text(lx, hy + 7 * pitch + 27, num(monthSum.get(week[0].date.slice(0, 7)) || 0), { size: 9.5, fill: C.text, weight: 600 }));
      }
      lastMonth = m;
    }
  });
  parts.push(monthLbls.join(''));
  parts.push(`<line x1="${b.x + PAD}" x2="${b.x + b.w - PAD}" y1="${y + 150}" y2="${y + 150}" stroke="${C.line}"/>`);
  [[`${st.current}`, 'Current streak', C.yellow], [`${st.longest}`, 'Longest streak', C.text],
    [`${st.active}`, 'Active days', C.text], [`${st.best}`, 'Best day', C.text]].forEach(([v, l, c], i) => {
    const sx = b.x + PAD + (i * (b.w - 2 * PAD)) / 4;
    parts.push(line(sx, y + 180, [[v, { size: 22, weight: 700, fill: c }], i < 3 ? [' days', { size: 12, fill: C.mute }] : ['', {}]]));
    parts.push(text(sx, y + 198, l.toUpperCase(), { size: 9.5, fill: C.dim, weight: 700, ls: 1 }));
  });
  y += H1 + G;

  // PR / Issues / Reviews / Stars
  const r2 = rowX([29, 29, 21, 21]);
  const H2 = 108;
  const pct = (p, t) => (t ? Math.round((p / t) * 100) : 0);
  const stat = (r, title, color, value, sub, ratio) => {
    parts.push(card(r.x, y, r.w, H2, title, color));
    parts.push(line(r.x + PAD, y + 72, [[num(value), { size: 32, weight: 700, fill: C.text }], sub ? [sub, { size: 12, dx: 9 }] : ['', {}]]));
    if (ratio !== undefined) parts.push(bar(r.x + PAD, y + 88, r.w - 2 * PAD, 7, ratio, color));
  };
  stat(r2[0], 'Pull requests', C.blue, d.pr.total, `${num(d.pr.merged)} merged · ${pct(d.pr.merged, d.pr.total)}%`, d.pr.total ? d.pr.merged / d.pr.total : 0);
  stat(r2[1], 'Issues', C.pink, d.issues.total, `${num(d.issues.closed)} closed · ${pct(d.issues.closed, d.issues.total)}%`, d.issues.total ? d.issues.closed / d.issues.total : 0);
  stat(r2[2], 'Reviews', C.purple, d.reviews);
  stat(r2[3], 'Stars', C.yellow, d.stars);
  y += H2 + G;

  // Forks / Watchers / Repos
  const r3 = rowX([26, 26, 48]);
  const H3 = 108;
  parts.push(card(r3[0].x, y, r3[0].w, H3, 'Forks', C.purple));
  parts.push(line(r3[0].x + PAD, y + 72, [[num(d.forks), { size: 32, weight: 700, fill: C.text }]]));
  parts.push(text(r3[0].x + PAD, y + 95, `${num(d.forksReceived)} on your repos`, { size: 11.5, fill: C.dim }));
  parts.push(card(r3[1].x, y, r3[1].w, H3, 'Watchers', C.blue));
  parts.push(line(r3[1].x + PAD, y + 72, [[num(d.watchers), { size: 32, weight: 700, fill: C.text }]]));
  parts.push(card(r3[2].x, y, r3[2].w, H3, 'Repositories', C.green));
  parts.push(line(r3[2].x + PAD, y + 72, [[num(d.reposOwn), { size: 32, weight: 700, fill: C.text }], [' own', { size: 12, dx: 6 }],
    [num(d.reposContrib), { size: 32, weight: 700, fill: C.text, dx: 26 }], [' contributed to', { size: 12, dx: 6 }]]));
  y += H3 + G;

  // Lines of code
  const H4 = 164;
  parts.push(card(M, y, CW, H4, 'Lines of code · all-time', C.pink, `net ${net >= 0 ? '+' : '−'}${short(Math.abs(net))}`));
  parts.push(line(M + PAD, y + 84, [[`+${short(add)}`, { size: 38, weight: 800, fill: C.green }], [`−${short(d.del)}`, { size: 38, weight: 800, fill: C.pink, dx: 22 }],
    [' added / removed', { size: 12.5, dx: 12 }]]));
  const bw = CW - 2 * PAD - 4;
  parts.push(`<rect x="${M + PAD}" y="${y + 104}" width="${Math.max(8, bw * hr)}" height="12" rx="6" fill="${C.green}"/>`);
  if (hr < 1) parts.push(`<rect x="${M + PAD + bw * hr + 4}" y="${y + 104}" width="${Math.max(8, bw * (1 - hr))}" height="12" rx="6" fill="${C.purple}"/>`);
  parts.push(`<circle cx="${M + PAD + 4}" cy="${y + 135}" r="4.5" fill="${C.green}"/>`);
  parts.push(line(M + PAD + 14, y + 139, [['Human', { weight: 700, fill: C.text, size: 12.5 }], [`  ${num(d.addHuman)} lines · ${Math.round(hr * 100)}%`, { size: 12.5 }]]));
  parts.push(`<circle cx="${M + CW / 2 + 4}" cy="${y + 135}" r="4.5" fill="${C.purple}"/>`);
  parts.push(line(M + CW / 2 + 14, y + 139, [['AI-assisted', { weight: 700, fill: C.text, size: 12.5 }], [`  ${num(d.addAI)} lines · ${Math.round((1 - hr) * 100)}%`, { size: 12.5 }]]));
  parts.push(text(M + PAD, y + 157, 'AI-assisted = commits with an AI co-author trailer (Claude, Copilot, …)', { size: 10, fill: C.dim }));
  y += H4 + G;

  // Languages + Top repos
  const [l1, l2] = rowX([50, 50]);
  const H5 = 190;
  const langs = d.languages.slice(0, 6).map((l) => ({ ...l, color: vivid(l.color) }));
  const lt = langs.reduce((s, l) => s + l.size, 0) || 1;
  parts.push(card(l1.x, y, l1.w, H5, 'Languages', C.yellow, langs[0] ? `Top: ${langs[0].name}` : ''));
  const lw = l1.w - 2 * PAD - 4 * (langs.length - 1);
  let lx = l1.x + PAD;
  langs.forEach((l) => {
    const w = (lw * l.size) / lt;
    parts.push(`<rect x="${lx}" y="${y + 52}" width="${Math.max(6, w)}" height="11" rx="5.5" fill="${l.color}"/>`);
    lx += Math.max(6, w) + 4;
  });
  langs.forEach((l, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const cx = l1.x + PAD + col * ((l1.w - 2 * PAD) / 2), cy = y + 100 + row * 30;
    parts.push(`<circle cx="${cx + 4}" cy="${cy - 4}" r="4.5" fill="${l.color}"/>`);
    parts.push(line(cx + 15, cy, [[l.name, { weight: 600, fill: C.text, size: 13 }], [`  ${Math.round((l.size / lt) * 100)}%`, { size: 13 }]]));
  });
  parts.push(card(l2.x, y, l2.w, H5, 'Top repos by commits', C.blue));
  const tmax = Math.max(1, ...d.topRepos.map((r) => r.count));
  d.topRepos.forEach((r, i) => {
    const ry = y + 66 + i * 24;
    parts.push(text(l2.x + PAD, ry + 4, r.name.length > 15 ? r.name.slice(0, 14) + '…' : r.name, { size: 12.5, fill: '#e6e6e6' }));
    parts.push(bar(l2.x + 140, ry - 3, l2.w - 140 - PAD - 40, 8, r.count / tmax, C.blue));
    parts.push(text(l2.x + l2.w - PAD, ry + 4, num(r.count), { size: 12, anchor: 'end', fill: C.text, weight: 600 }));
  });
  y += H5 + G;

  // Commits per month
  const H6 = 206;
  parts.push(card(M, y, CW, H6, 'Commits per month', C.green));
  parts.push(`<rect x="${M + CW - PAD - 88}" y="${y + 21}" width="9" height="9" rx="2" fill="${C.green}"/>`, text(M + CW - PAD - 75, y + 30, 'Human', { size: 11 }));
  parts.push(`<rect x="${M + CW - PAD - 36}" y="${y + 21}" width="9" height="9" rx="2" fill="${C.purple}"/>`, text(M + CW - PAD - 23, y + 30, 'AI', { size: 11 }));
  const mmax = Math.max(1, ...d.monthly.map((m) => m.human + m.ai));
  const slot = (CW - 2 * PAD) / d.monthly.length, bwid = slot * 0.7, area = 104, base = y + 60 + area;
  d.monthly.forEach((m, i) => {
    const bx = M + PAD + i * slot + (slot - bwid) / 2;
    const hh = (m.human / mmax) * area, ah = (m.ai / mmax) * area, tot = m.human + m.ai;
    if (hh > 0) parts.push(`<rect x="${bx.toFixed(1)}" y="${(base - hh).toFixed(1)}" width="${bwid.toFixed(1)}" height="${hh.toFixed(1)}" rx="3" fill="${C.green}"/>`);
    if (ah > 0) parts.push(`<rect x="${bx.toFixed(1)}" y="${(base - hh - ah - (hh > 0 ? 1.5 : 0)).toFixed(1)}" width="${bwid.toFixed(1)}" height="${ah.toFixed(1)}" rx="3" fill="${C.purple}"/>`);
    const topY = base - hh - ah - (hh > 0 && ah > 0 ? 1.5 : 0);
    parts.push(text((bx + bwid / 2).toFixed(1), (tot ? topY : base) - 7, String(tot), { size: 11.5, fill: C.text, weight: 700, anchor: 'middle' }));
    parts.push(text((bx + bwid / 2).toFixed(1), base + 18, m.label, { size: 11, fill: C.dim, anchor: 'middle' }));
  });
  y += H6 + G;

  // Weekday + Hour
  const [w1, w2] = rowX([38, 62]);
  const H7 = 186;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const wpeak = d.weekday.indexOf(Math.max(...d.weekday));
  parts.push(card(w1.x, y, w1.w, H7, 'By weekday', C.yellow, `Peak: ${DAYS[wpeak]}`));
  columns(parts, w1.x + PAD, y + 66, w1.w - 2 * PAD, 84, d.weekday.map((v, i) => ({ value: v, label: DAYS[i], color: i === wpeak ? C.green : C.bar, strong: i === wpeak })), { labelSize: 10.5, valueSize: 10.5 });
  const hpeak = d.hours.indexOf(Math.max(...d.hours));
  const mood = hpeak >= 21 || hpeak < 5 ? 'night owl' : hpeak < 10 ? 'early bird' : 'daytime';
  parts.push(card(w2.x, y, w2.w, H7, 'By hour of day', C.purple, `Peak ${String(hpeak).padStart(2, '0')}:00 · ${mood}`));
  columns(parts, w2.x + PAD, y + 66, w2.w - 2 * PAD, 84,
    d.hours.map((v, i) => ({ value: v, label: [0, 6, 12, 18, 23].includes(i) ? String(i).padStart(2, '0') : '', color: i === hpeak ? C.purple : C.bar, strong: i === hpeak })),
    { labelSize: 10.5, valueSize: 8.5, gap: 0.2 });
  y += H7 + 14;

  parts.push(text(W - M, y + 4, `Updated ${dateStr} · generated automatically by GitHub Actions`, { size: 10.5, fill: C.dim, anchor: 'end' }));
  const H = y + 14;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', -apple-system, 'Helvetica Neue', Arial, sans-serif">
${parts.join('\n')}
</svg>
`;
}

const data = process.argv.includes('--demo') ? demoData() : await fetchData();
writeFileSync(OUT, render(data));
writeFileSync(OUT_JSON, JSON.stringify(data));
console.log(`geschrieben: ${OUT} (${data.commitsAll} Commits, ${data.addHuman + data.addAI} Zeilen)`);
