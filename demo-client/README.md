# Demo client: Acme Store (S2)

A tiny shop that shows **why** the Feature Flag Manager exists. When a shopper opens checkout,
the store asks the Feature Flag Manager whether `new-checkout` is on for that shopper and shows
either the new one-page checkout or the classic 3-step checkout. Change the percentage on the
rollout page and the shop changes, with no redeploy.

```
browser ──GET /api/flag?user=u-981──▶ demo server function ──POST /api/v1/evaluations──▶ Feature Flag Manager
        ◀──── { enabled: true } ─────                      ◀── Bearer ffm_stg_… (secret) ──
```

## Security choices

- **The API key never reaches the browser.** Only the demo's own server function (`api/flag.js`)
  holds it, as an environment variable. The browser sees `{ enabled }` and nothing else.
- **Staging key only.** The key decides the environment, so this demo can never read prod values.
- **Only listed flags.** `FLAG_KEYS` limits which flags can be asked about, so the demo cannot be
  used to read every flag of the team.
- **Fail closed.** If the flag service is slow (3 s timeout), down (503), rate-limiting (429) or
  rejects the key (401), the shop shows the classic checkout. A flag problem never breaks the shop.
- Same security headers as the main app (CSP with `script-src 'self'`, no inline scripts,
  `nosniff`, no framing). Page text is set with `textContent`, never `innerHTML`.

## Run it on your PC

1. Create a staging key (from the repo root): `npm run seed:key`, and copy the key.
2. In `demo-client/`, copy `.env.example` to `.env` and paste the key into `FFM_API_KEY`.
3. `cd demo-client` then `npm start`, and open http://localhost:4000

## Deploy it (a second, separate Vercel project)

1. Vercel → Add New → Project → import this same repo.
2. Project name e.g. `ffm-demo-shop`; **Root Directory: `demo-client`**; Framework: Other.
3. Environment variables (Production): `FFM_API_URL`, `FFM_API_KEY` (the **staging** key), `FLAG_KEYS=new-checkout`.
4. Deploy. The main app's project and secrets are not touched; this project holds only the staging key.

## Files

| File | What it does |
|---|---|
| `lib/flag-client.js` | Calls `/evaluations`, validates input, fails closed. Used by both runners |
| `api/flag.js` | Vercel function `GET /api/flag` |
| `server.js` | Local runner on port 4000 (static files + `/api/flag`) |
| `public/` | The shop page (`index.html`, `app.js`, `styles.css`) |
| `__tests__/` | Jest tests (run from the repo root with `npm test`) |
