// Erzeugt stats.svg aus den GitHub-Daten des Profils.
// Nutzung:  node generate.mjs          (echte Daten, braucht STATS_TOKEN + STATS_LOGIN)
//           node generate.mjs --demo   (Dummy-Daten zum Design-Check)
import { writeFileSync } from 'node:fs';

const TOKEN = (process.env.STATS_TOKEN || process.env.GITHUB_TOKEN || '').trim() || undefined;
const LOGIN = process.env.STATS_LOGIN || process.env.GITHUB_REPOSITORY_OWNER;
const TZ = process.env.STATS_TZ || 'Europe/Berlin';
const LINE_CAP = Number(process.env.STATS_LINE_CAP || 10000); // ignoriert Mega-Commits (Asset-Importe etc.)
const MAX_PAGES = Number(process.env.STATS_MAX_PAGES || 30); // 100 Commits pro Seite und Repo
const OUT = process.env.STATS_OUT || 'stats.svg';
const OUT_JSON = process.env.STATS_JSON || 'stats.json';
const AI_RE =
  /co-authored-by:[^\n]*(claude|anthropic|copilot|chatgpt|openai|codex|gemini|cursor|aider|devin)|generated with \[?claude/i;

// ---------------------------------------------------------------- Daten holen

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

async function fetchData() {
  if (!TOKEN || !LOGIN) throw new Error('STATS_TOKEN (oder GITHUB_TOKEN) und STATS_LOGIN fehlen');

  const { user: u } = await gql(
    `query($login:String!){ user(login:$login){
      id login name createdAt
      followers{totalCount} following{totalCount} organizations{totalCount}
      gists{totalCount} starredRepositories{totalCount}
      pullRequests{totalCount} mergedPRs: pullRequests(states:MERGED){totalCount}
      issues{totalCount} closedIssues: issues(states:CLOSED){totalCount}
      repositories(ownerAffiliations:OWNER,isFork:false){totalCount}
      repositoriesContributedTo(includeUserRepositories:false,contributionTypes:[COMMIT,PULL_REQUEST,REPOSITORY]){totalCount}
      contributionsCollection{
        totalCommitContributions
        contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
      }
    } }`,
    { login: LOGIN },
  );

  // Commits/Contributions/Reviews pro Jahr seit Account-Erstellung
  const now = new Date();
  const startYear = new Date(u.createdAt).getUTCFullYear();
  let yq = 'query($login:String!){ user(login:$login){';
  for (let y = startYear; y <= now.getUTCFullYear(); y++) {
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    yq += `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${to}"){
      totalCommitContributions restrictedContributionsCount totalPullRequestReviewContributions
      contributionCalendar{ totalContributions } }`;
  }
  yq += '} }';
  const years = Object.values((await gql(yq, { login: LOGIN })).user);
  const commitsAll = years.reduce((s, y) => s + y.totalCommitContributions + y.restrictedContributionsCount, 0);
  const totalContribAll = years.reduce((s, y) => s + y.contributionCalendar.totalContributions, 0);
  const reviews = years.reduce((s, y) => s + y.totalPullRequestReviewContributions, 0);

  // eigene Repos (Sterne, Forks, Watcher, Sprachen)
  const own = [];
  for (let after = null, more = true; more; ) {
    const d = await gql(
      `query($login:String!,$after:String){ user(login:$login){
        repositories(ownerAffiliations:OWNER,isFork:false,first:100,after:$after){
          pageInfo{hasNextPage endCursor}
          nodes{ nameWithOwner isPrivate stargazerCount forkCount watchers{totalCount}
            languages(first:10,orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } } } } } }`,
      { login: LOGIN, after },
    );
    own.push(...d.user.repositories.nodes);
    more = d.user.repositories.pageInfo.hasNextPage;
    after = d.user.repositories.pageInfo.endCursor;
  }
  const contributed = (
    await gql(
      `query($login:String!){ user(login:$login){
        repositoriesContributedTo(first:100,includeUserRepositories:false,contributionTypes:[COMMIT,PULL_REQUEST]){ nodes{ nameWithOwner isPrivate } } } }`,
      { login: LOGIN },
    )
  ).user.repositoriesContributedTo.nodes;

  const langMap = new Map();
  for (const r of own)
    for (const e of r.languages.edges) {
      const l = langMap.get(e.node.name) || { name: e.node.name, color: e.node.color || '#888', size: 0 };
      l.size += e.size;
      langMap.set(e.node.name, l);
    }

  // Commit-Historie: Zeit, Zeilen, AI-Trailer
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  });
  const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const monthKeys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en', { month: 'short' })[0], name: d.toLocaleString('en', { month: 'long', year: 'numeric' }) });
  }
  const monthly = new Map(monthKeys.map((m) => [m.key, { label: m.label, name: m.name, human: 0, ai: 0 }]));
  const weekday = Array(7).fill(0);
  const hours = Array(24).fill(0);
  const repoCount = new Map();
  let addHuman = 0, addAI = 0, del = 0;

  const priv = new Set([...own, ...contributed].filter((r) => r.isPrivate).map((r) => r.nameWithOwner));
  const repos = [...new Set([...own, ...contributed].map((r) => r.nameWithOwner))];
  for (const full of repos) {
    const [owner, name] = full.split('/');
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await gql(
        `query($owner:String!,$name:String!,$id:ID!,$after:String){ repository(owner:$owner,name:$name){
          defaultBranchRef{ target{ ... on Commit{ history(first:100,after:$after,author:{id:$id}){
            pageInfo{hasNextPage endCursor} nodes{ committedDate additions deletions message } } } } } } }`,
        { owner, name, id: u.id, after },
      );
      const h = d.repository?.defaultBranchRef?.target?.history;
      if (!h) break;
      for (const c of h.nodes) {
        const ai = AI_RE.test(c.message);
        const p = Object.fromEntries(fmt.formatToParts(new Date(c.committedDate)).map((x) => [x.type, x.value]));
        const m = monthly.get(`${p.year}-${p.month}`);
        if (m) m[ai ? 'ai' : 'human']++;
        weekday[WD[p.weekday]]++;
        hours[Number(p.hour)]++;
        repoCount.set(full, (repoCount.get(full) || 0) + 1);
        const a = Math.min(c.additions, LINE_CAP);
        if (ai) addAI += a; else addHuman += a;
        del += Math.min(c.deletions, LINE_CAP);
      }
      if (!h.pageInfo.hasNextPage) break;
      after = h.pageInfo.endCursor;
    }
  }

  const weeks = u.contributionsCollection.contributionCalendar.weeks.map((w) =>
    w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })),
  );

  return {
    login: u.login, name: u.name || u.login, joined: startYear,
    followers: u.followers.totalCount, following: u.following.totalCount,
    orgs: u.organizations.totalCount, gists: u.gists.totalCount, starred: u.starredRepositories.totalCount,
    commitsAll, commitsYear: u.contributionsCollection.totalCommitContributions,
    totalContribAll, contribYear: u.contributionsCollection.contributionCalendar.totalContributions,
    weeks,
    pr: { total: u.pullRequests.totalCount, merged: u.mergedPRs.totalCount },
    issues: { total: u.issues.totalCount, closed: u.closedIssues.totalCount },
    reviews,
    stars: own.reduce((s, r) => s + r.stargazerCount, 0),
    forks: own.reduce((s, r) => s + r.forkCount, 0),
    watchers: own.reduce((s, r) => s + r.watchers.totalCount, 0),
    reposOwn: u.repositories.totalCount, reposContrib: u.repositoriesContributedTo.totalCount,
    addHuman, addAI, del,
    languages: [...langMap.values()].sort((a, b) => b.size - a.size),
    monthly: [...monthly.values()],
    topRepos: (() => { let n = 0; // private Repos nie namentlich anzeigen
      return [...repoCount].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([full, count]) => ({ name: priv.has(full) ? `private repo ${++n}` : full.split('/')[1], count })); })(),
    weekday, hours, updated: now,
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
  return {
    login: 'username', name: 'Nicolas', joined: 2021,
    followers: 64, following: 48, orgs: 2, gists: 5, starred: 203,
    commitsAll: 2847, commitsYear: 2009, totalContribAll: 3141, contribYear: 2151,
    weeks,
    pr: { total: 143, merged: 121 }, issues: { total: 62, closed: 55 }, reviews: 89, stars: 318,
    forks: 41, watchers: 22, reposOwn: 27, reposContrib: 14,
    addHuman: 136000, addAI: 48000, del: 61000,
    languages: [
      { name: 'TypeScript', color: '#38bdf8', size: 31 }, { name: 'Python', color: '#b794ff', size: 24 },
      { name: 'C#', color: '#34f5a0', size: 18 }, { name: 'JavaScript', color: '#fbbf24', size: 11 },
      { name: 'HTML', color: '#ff5c9a', size: 9 }, { name: 'CSS', color: '#6b8afd', size: 7 },
    ],
    monthly: ['N', 'D', 'J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O'].map((label, i) => ({ label, human: human[i], ai: ai[i] })),
    topRepos: [
      { name: 'portfolio', count: 612 }, { name: 'game-prototype', count: 548 },
      { name: 'dotfiles', count: 301 }, { name: 'uni-notes', count: 190 },
    ],
    weekday: [40, 62, 44, 48, 46, 28, 32],
    hours: [30, 22, 12, 6, 4, 3, 5, 9, 16, 24, 32, 38, 48, 52, 44, 40, 46, 42, 38, 50, 58, 66, 92, 30],
    updated: new Date('2026-10-19T12:00:00Z'),
  };
}

// ---------------------------------------------------------------- Rendern

const C = { bg: '#0a0a0a', card: '#121212', line: '#242424', text: '#ffffff', mute: '#8b8b8b', dim: '#5c5c5c',
  green: '#34f5a0', purple: '#b794ff', blue: '#38bdf8', pink: '#ff5c9a', yellow: '#fbbf24', track: '#2a2a2a' };
const W = 720, M = 1, G = 10, CW = W - 2 * M;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => Math.round(n).toLocaleString('de-DE');
const short = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const tw = (s, size) => String(s).length * size * 0.56;
const text = (x, y, s, { size = 11, fill = C.mute, weight = 400, anchor = 'start', ls = 0, filter = '' } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}"${ls ? ` letter-spacing="${ls}"` : ''}${filter ? ` filter="url(#glow)"` : ''}>${esc(s)}</text>`;
const label = (x, y, s, o = {}) => text(x, y, s.toUpperCase(), { size: 9.5, weight: 700, ls: 1, ...o });

function card(x, y, w, h, title, color, right = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.card}" stroke="${C.line}"/>
<circle cx="${x + 24}" cy="${y + 24}" r="10" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-opacity="0.5"/>
<circle cx="${x + 24}" cy="${y + 24}" r="3" fill="${color}"/>
${label(x + 42, y + 28, title)}${right ? text(x + w - 16, y + 28, right, { size: 10, anchor: 'end' }) : ''}`;
}

const bar = (x, y, w, h, ratio, color) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.track}"/>` +
  (ratio > 0 ? `<rect x="${x}" y="${y}" width="${Math.max(h, w * Math.min(ratio, 1))}" height="${h}" rx="${h / 2}" fill="${color}" filter="url(#glow)"/>` : '');

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

function render(d) {
  const parts = [];
  let y = M;
  const dateStr = d.updated.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  // Header
  const pills = [[d.followers, 'followers'], [d.following, 'following'], [d.orgs, 'orgs'], [d.gists, 'gists'], [d.starred, 'starred']];
  parts.push(`<circle cx="${M + 24}" cy="${y + 28}" r="21" fill="#0f1f18" stroke="${C.green}" stroke-width="1.5" filter="url(#glow)"/>`);
  parts.push(text(M + 24, y + 35, d.name[0].toUpperCase(), { size: 20, fill: C.green, weight: 700, anchor: 'middle' }));
  parts.push(text(M + 58, y + 24, d.name, { size: 17, fill: C.text, weight: 700 }));
  parts.push(text(M + 58, y + 42, `@${d.login} · joined ${d.joined}`, { size: 11, fill: C.dim }));
  let px = W - M;
  for (const [n, l] of [...pills].reverse()) {
    const w = (String(n).length + l.length + 1) * 6.4 + 26;
    px -= w;
    parts.push(`<rect x="${px}" y="${y + 14}" width="${w}" height="28" rx="14" fill="#151515" stroke="#2c2c2c"/>`);
    parts.push(`<text x="${px + 13}" y="${y + 32}" font-size="11"><tspan fill="#fff" font-weight="700">${esc(num(n))}</tspan><tspan fill="#9a9a9a"> ${l}</tspan></text>`);
    px -= 8;
  }
  y += 66;

  // Commits + Heatmap
  const [a, b] = rowX([230, 448]);
  const st = streaks(d.weeks);
  const H1 = 172;
  parts.push(card(a.x, y, a.w, H1, 'Commits · all-time', C.green));
  parts.push(text(a.x + 22, y + 96, num(d.commitsAll), { size: 54, fill: C.text, weight: 800, filter: true }));
  parts.push(text(a.x + 22, y + 118, `${num(d.commitsYear)} in the last 12 months`, { size: 11 }));
  parts.push(`<line x1="${a.x + 22}" x2="${a.x + a.w - 22}" y1="${y + 134}" y2="${y + 134}" stroke="${C.line}"/>`);
  parts.push(text(a.x + 22, y + 158, 'Total contributions', { size: 11 }));
  parts.push(text(a.x + a.w - 22, y + 160, num(d.totalContribAll), { size: 18, fill: C.text, weight: 700, anchor: 'end' }));

  parts.push(card(b.x, y, b.w, H1, `${num(d.contribYear)} contributions in the last year`, C.purple));
  const lv = ['#1d211f', '#0e4f35', '#12804f', '#1fb870', C.green];
  parts.push(text(b.x + b.w - 16 - 5 * 9 - 30, y + 28, 'Less', { size: 9, anchor: 'end' }));
  lv.forEach((c, i) => parts.push(`<rect x="${b.x + b.w - 16 - 5 * 9 - 22 + i * 9}" y="${y + 21}" width="7" height="7" rx="1.5" fill="${c}"/>`));
  parts.push(text(b.x + b.w - 16, y + 28, 'More', { size: 9, anchor: 'end' }));
  const hx = b.x + 16, hy = y + 44, pitch = (b.w - 32) / 53, cell = pitch - 1.8;
  const max = Math.max(1, ...d.weeks.flat().map((x) => x.count));
  const heat = [[], [], [], [], []];
  let lastMonth = -1;
  const monthLbls = [];
  d.weeks.forEach((week, wi) => {
    week.forEach((day) => {
      const dow = new Date(day.date + 'T00:00:00Z').getUTCDay();
      const l = day.count === 0 ? 0 : Math.min(4, Math.ceil((day.count / max) * 4));
      heat[l].push(`<rect x="${(hx + wi * pitch).toFixed(1)}" y="${(hy + dow * pitch).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="1.6" fill="${lv[l]}"/>`);
    });
    const m = new Date(week[0].date + 'T00:00:00Z').getUTCMonth();
    if (m !== lastMonth) {
      if (lastMonth !== -1) monthLbls.push(text(hx + wi * pitch, hy + 7 * pitch + 12, new Date(Date.UTC(2000, m, 1)).toLocaleString('en', { month: 'short' }), { size: 8.5, fill: C.dim }));
      lastMonth = m;
    }
  });
  parts.push(heat.slice(0, 4).map((r) => r.join('')).join(''));
  parts.push(`<g filter="url(#glow)">${heat[4].join('')}</g>`);
  parts.push(monthLbls.join(''));
  parts.push(`<line x1="${b.x + 16}" x2="${b.x + b.w - 16}" y1="${y + 124}" y2="${y + 124}" stroke="${C.line}"/>`);
  [[`${st.current} days`, 'Current streak', C.yellow], [`${st.longest} days`, 'Longest streak', C.text],
    [`${st.active} days`, 'Active days', C.text], [String(st.best), 'Best day', C.text]].forEach(([v, l, c], i) => {
    const sx = b.x + 20 + (i * (b.w - 40)) / 4;
    parts.push(text(sx, y + 146, v, { size: 15, fill: c, weight: 700 }));
    parts.push(label(sx, y + 161, l, { size: 8, fill: C.dim }));
  });
  y += H1 + G;

  // PR / Issues / Reviews / Stars
  const r2 = rowX([215, 215, 125, 125]);
  const H2 = 84;
  const pct = (p, t) => (t ? Math.round((p / t) * 100) : 0);
  parts.push(card(r2[0].x, y, r2[0].w, H2, 'Pull requests', C.blue));
  parts.push(text(r2[0].x + 18, y + 56, num(d.pr.total), { size: 24, fill: C.text, weight: 700 }));
  parts.push(text(r2[0].x + 24 + String(num(d.pr.total)).length * 14, y + 56, `${num(d.pr.merged)} merged · ${pct(d.pr.merged, d.pr.total)}%`, { size: 10 }));
  parts.push(bar(r2[0].x + 18, y + 68, r2[0].w - 36, 6, d.pr.total ? d.pr.merged / d.pr.total : 0, C.blue));
  parts.push(card(r2[1].x, y, r2[1].w, H2, 'Issues', C.pink));
  parts.push(text(r2[1].x + 18, y + 56, num(d.issues.total), { size: 24, fill: C.text, weight: 700 }));
  parts.push(text(r2[1].x + 24 + String(num(d.issues.total)).length * 14, y + 56, `${num(d.issues.closed)} closed · ${pct(d.issues.closed, d.issues.total)}%`, { size: 10 }));
  parts.push(bar(r2[1].x + 18, y + 68, r2[1].w - 36, 6, d.issues.total ? d.issues.closed / d.issues.total : 0, C.pink));
  parts.push(card(r2[2].x, y, r2[2].w, H2, 'Reviews', C.purple));
  parts.push(text(r2[2].x + 18, y + 64, num(d.reviews), { size: 24, fill: C.text, weight: 700 }));
  parts.push(card(r2[3].x, y, r2[3].w, H2, 'Stars', C.yellow));
  parts.push(text(r2[3].x + 18, y + 64, num(d.stars), { size: 24, fill: C.text, weight: 700 }));
  y += H2 + G;

  // Forks / Watchers / Repos / Lines
  const r3 = rowX([125, 110, 225, 235]);
  const H3 = 74;
  parts.push(card(r3[0].x, y, r3[0].w, H3, 'Forks', C.purple));
  parts.push(text(r3[0].x + 18, y + 58, num(d.forks), { size: 24, fill: C.text, weight: 700 }));
  parts.push(card(r3[1].x, y, r3[1].w, H3, 'Watchers', C.blue));
  parts.push(text(r3[1].x + 18, y + 58, num(d.watchers), { size: 24, fill: C.text, weight: 700 }));
  parts.push(card(r3[2].x, y, r3[2].w, H3, 'Repositories', C.green));
  parts.push(text(r3[2].x + 18, y + 58, num(d.reposOwn), { size: 24, fill: C.text, weight: 700 }));
  parts.push(text(r3[2].x + 24 + String(num(d.reposOwn)).length * 14, y + 58, 'own', { size: 10 }));
  const cx = r3[2].x + 96;
  parts.push(text(cx, y + 58, num(d.reposContrib), { size: 24, fill: C.text, weight: 700 }));
  parts.push(text(cx + 6 + String(num(d.reposContrib)).length * 14, y + 58, 'contributed to', { size: 10 }));
  const add = d.addHuman + d.addAI;
  parts.push(card(r3[3].x, y, r3[3].w, H3, 'Lines changed', C.pink, `net ${add - d.del >= 0 ? '+' : '−'}${short(Math.abs(add - d.del))}`));
  parts.push(text(r3[3].x + 18, y + 58, `+${short(add)}`, { size: 22, fill: C.green, weight: 800, filter: true }));
  parts.push(text(r3[3].x + 24 + (short(add).length + 1) * 13 + 6, y + 58, `−${short(d.del)}`, { size: 22, fill: C.pink, weight: 800, filter: true }));
  y += H3 + G;

  // Human vs AI + Languages
  const [h1, h2] = rowX([336, 342]);
  const H4 = 108;
  parts.push(card(h1.x, y, h1.w, H4, 'Lines added · Human vs AI', C.yellow, `${short(add)} total`));
  const hr = add ? d.addHuman / add : 1;
  const bw = h1.w - 32 - 4;
  parts.push(`<rect x="${h1.x + 16}" y="${y + 42}" width="${bw * hr}" height="13" rx="6.5" fill="${C.green}" filter="url(#glow)"/>`);
  parts.push(`<rect x="${h1.x + 16 + bw * hr + 4}" y="${y + 42}" width="${Math.max(0, bw * (1 - hr))}" height="13" rx="6.5" fill="${C.purple}"/>`);
  parts.push(`<circle cx="${h1.x + 20}" cy="${y + 73}" r="4" fill="${C.green}"/>`);
  parts.push(`<text x="${h1.x + 30}" y="${y + 77}" font-size="11"><tspan fill="#fff" font-weight="700">Human</tspan><tspan fill="${C.mute}">  ${short(d.addHuman)} · ${Math.round(hr * 100)}%</tspan></text>`);
  parts.push(`<circle cx="${h1.x + 190}" cy="${y + 73}" r="4" fill="${C.purple}"/>`);
  parts.push(`<text x="${h1.x + 200}" y="${y + 77}" font-size="11"><tspan fill="#fff" font-weight="700">AI-assisted</tspan><tspan fill="${C.mute}">  ${short(d.addAI)} · ${Math.round((1 - hr) * 100)}%</tspan></text>`);
  parts.push(text(h1.x + 16, y + 98, 'AI-assisted = commits with an AI co-author trailer (Claude, Copilot, …)', { size: 8.5, fill: C.dim }));

  const langs = d.languages.slice(0, 6);
  const lt = langs.reduce((s, l) => s + l.size, 0) || 1;
  parts.push(card(h2.x, y, h2.w, H4, 'Languages', C.yellow, langs[0] ? `Top: ${langs[0].name}` : ''));
  const lw = h2.w - 32 - 4 * (langs.length - 1);
  let lx = h2.x + 16;
  langs.forEach((l) => {
    const w = (lw * l.size) / lt;
    parts.push(`<rect x="${lx}" y="${y + 42}" width="${Math.max(6, w)}" height="10" rx="5" fill="${l.color}"/>`);
    lx += w + 4;
  });
  langs.forEach((l, i) => {
    const cxl = h2.x + 20 + (i % 3) * 108, cyl = y + 72 + Math.floor(i / 3) * 22;
    parts.push(`<circle cx="${cxl}" cy="${cyl - 3}" r="4" fill="${l.color}"/>`);
    parts.push(`<text x="${cxl + 10}" y="${cyl}" font-size="10.5"><tspan fill="#fff" font-weight="600">${esc(l.name)}</tspan><tspan fill="${C.mute}">  ${Math.round((l.size / lt) * 100)}%</tspan></text>`);
  });
  y += H4 + G;

  // Commits per month + Top repos
  const [m1, m2] = rowX([336, 342]);
  const H5 = 136;
  parts.push(card(m1.x, y, m1.w, H5, 'Commits per month', C.green));
  parts.push(`<rect x="${m1.x + m1.w - 100}" y="${y + 20}" width="8" height="8" rx="2" fill="${C.green}"/>`, text(m1.x + m1.w - 88, y + 28, 'Human', { size: 9.5 }));
  parts.push(`<rect x="${m1.x + m1.w - 48}" y="${y + 20}" width="8" height="8" rx="2" fill="${C.purple}"/>`, text(m1.x + m1.w - 36, y + 28, 'AI', { size: 9.5 }));
  const mmax = Math.max(1, ...d.monthly.map((m) => m.human + m.ai));
  const base = y + H5 - 24, area = 64, slot = (m1.w - 32) / d.monthly.length, bwid = slot - 7;
  d.monthly.forEach((m, i) => {
    const bx = m1.x + 16 + i * slot + 3.5;
    const hh = (m.human / mmax) * area, ah = (m.ai / mmax) * area;
    if (hh > 0) parts.push(`<rect x="${bx}" y="${base - hh}" width="${bwid}" height="${hh}" rx="2.5" fill="${C.green}"/>`);
    if (ah > 0) parts.push(`<rect x="${bx}" y="${base - hh - ah - (hh > 0 ? 1.5 : 0)}" width="${bwid}" height="${ah}" rx="2.5" fill="${C.purple}"/>`);
    parts.push(text(bx + bwid / 2, base + 14, m.label, { size: 9, fill: C.dim, anchor: 'middle' }));
  });
  parts.push(card(m2.x, y, m2.w, H5, 'Top repos by commits', C.blue));
  const tmax = Math.max(1, ...d.topRepos.map((r) => r.count));
  d.topRepos.forEach((r, i) => {
    const ry = y + 56 + i * 24;
    parts.push(text(m2.x + 16, ry + 4, r.name.length > 16 ? r.name.slice(0, 15) + '…' : r.name, { size: 11.5, fill: '#e6e6e6' }));
    parts.push(bar(m2.x + 130, ry - 4, m2.w - 130 - 56, 7, r.count / tmax, C.blue));
    parts.push(text(m2.x + m2.w - 16, ry + 4, num(r.count), { size: 10.5, anchor: 'end' }));
  });
  y += H5 + G;

  // Weekday + Hour
  const [w1, w2] = rowX([200, 488]);
  const H6 = 118;
  const wmax = Math.max(1, ...d.weekday), wpeak = d.weekday.indexOf(Math.max(...d.weekday));
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  parts.push(card(w1.x, y, w1.w, H6, 'By weekday', C.yellow, `Peak: ${DAYS[wpeak]}`));
  const wslot = (w1.w - 32) / 7, wb = wslot - 6, wbase = y + H6 - 22;
  d.weekday.forEach((v, i) => {
    const hh = Math.max(3, (v / wmax) * 52), bx = w1.x + 16 + i * wslot + 3;
    parts.push(`<rect x="${bx}" y="${wbase - hh}" width="${wb}" height="${hh}" rx="3" fill="${i === wpeak ? C.green : '#2f3340'}"${i === wpeak ? ' filter="url(#glow)"' : ''}/>`);
    parts.push(text(bx + wb / 2, wbase + 14, 'MTWTFSS'[i], { size: 9, fill: C.dim, anchor: 'middle' }));
  });
  const hmax = Math.max(1, ...d.hours), hpeak = d.hours.indexOf(Math.max(...d.hours));
  const mood = hpeak >= 21 || hpeak < 5 ? 'night owl' : hpeak < 10 ? 'early bird' : 'daytime';
  parts.push(card(w2.x, y, w2.w, H6, 'By hour of day', C.purple, `Peak ${String(hpeak).padStart(2, '0')}:00 · ${mood}`));
  const hslot = (w2.w - 32) / 24, hb = hslot - 3;
  d.hours.forEach((v, i) => {
    const hh = Math.max(3, (v / hmax) * 52), bx = w2.x + 16 + i * hslot + 1.5;
    parts.push(`<rect x="${bx}" y="${wbase - hh}" width="${hb}" height="${hh}" rx="2.5" fill="${i === hpeak ? C.purple : '#2f3340'}"${i === hpeak ? ' filter="url(#glow)"' : ''}/>`);
  });
  [0, 6, 12, 18, 23].forEach((h) => parts.push(text(w2.x + 16 + h * hslot + hb / 2 + 1.5, wbase + 14, String(h).padStart(2, '0'), { size: 9, fill: C.dim, anchor: 'middle' })));
  y += H6 + 12;

  parts.push(text(W - M, y + 4, `Updated ${dateStr} · generated daily by GitHub Actions`, { size: 9, fill: C.dim, anchor: 'end' }));
  const H = y + 14;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', -apple-system, 'Helvetica Neue', Arial, sans-serif">
<defs><filter id="glow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
${parts.join('\n')}
</svg>
`;
}

const data = process.argv.includes('--demo') ? demoData() : await fetchData();
writeFileSync(OUT, render(data));
writeFileSync(OUT_JSON, JSON.stringify(data));
console.log(`geschrieben: ${OUT}`);
