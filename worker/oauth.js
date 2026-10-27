// Cloudflare Worker für die Owner-Anmeldung der Website (siehe SETUP-LOGIN.md).
// Tauscht den OAuth-Code gegen den GitHub-Login-Namen. Der Zugriffstoken verlässt den Worker nie und wird nicht gespeichert.
// Variablen: CLIENT_ID, CLIENT_SECRET (als Secret), ALLOWED_ORIGIN (z. B. https://nkunze2306.github.io)
export default {
  async fetch(req, env) {
    const cors = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/token') return reply({ error: 'not found' }, 404);
    if (req.headers.get('Origin') !== env.ALLOWED_ORIGIN) return reply({ error: 'forbidden' }, 403);
    let code;
    try { ({ code } = await req.json()); } catch { return reply({ error: 'bad request' }, 400); }
    if (typeof code !== 'string' || !/^[\w-]{8,64}$/.test(code)) return reply({ error: 'bad code' }, 400);
    const t = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'stats-login' },
      body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, code }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!t.access_token) return reply({ error: 'token exchange failed' }, 401);
    const u = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'stats-login', Accept: 'application/vnd.github+json' } }).then((r) => r.json()).catch(() => ({}));
    return u.login ? reply({ login: u.login }) : reply({ error: 'no user' }, 401);
  },
};
