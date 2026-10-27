# Owner-Anmeldung einrichten (einmalig)

Damit die Settings-Leiste auf jedem Gerät erscheint, sobald du bei GitHub eingeloggt bist, braucht die Seite eine OAuth-App und einen kleinen Worker.
Der Worker sieht nur den Login-Namen, speichert nichts und behält den Token nicht. Gespeichert wird weiter nur über das Issue, das der Workflow dem Owner zuordnet.

1. **OAuth-App** (GitHub → Settings → Developer settings → OAuth Apps → New OAuth App)
   - Homepage URL und Authorization callback URL: `https://nkunze2306.github.io/nkunze2306/`
   - Danach die **Client ID** notieren und ein **Client secret** erzeugen.
2. **Worker** (kostenloser Cloudflare-Account)
   ```bash
   cd worker && npx wrangler deploy oauth.js --name stats-login --compatibility-date 2024-11-01
   npx wrangler secret put CLIENT_SECRET --name stats-login      # Client secret einfügen
   npx wrangler deploy oauth.js --name stats-login --compatibility-date 2024-11-01 \
     --var CLIENT_ID:<Client ID> --var ALLOWED_ORIGIN:https://nkunze2306.github.io
   ```
   Die Worker-URL (`https://stats-login.<konto>.workers.dev`) notieren.
3. **Eintragen:** in `index.html` oben bei `const AUTH = { clientId: '', worker: '' }` Client ID und Worker-URL setzen (ohne Slash am Ende), committen.

Nutzung: Auf einem neuen Gerät einmal `https://nkunze2306.github.io/nkunze2306/#settings` öffnen (als Lesezeichen speichern). Die Seite leitet zu GitHub, du bestätigst, und die Leiste erscheint.
Ohne Anmeldung zeigt die Seite in der Fußzeile nur „Owner sign-in“.
