# frontend/

The Feature Flag Manager web app: React + Vite, built to `frontend/dist` and served by Vercel
(or by the S3 website `ffm-web` on Floci).

| Folder | Pages | Owner |
|---|---|---|
| `src/auth/` | sign-in with the Turnstile widget | S1 Youssef |
| `src/flags/` | flags list, search, create, edit, archive, toggle per environment | S1 Youssef |
| `src/rollouts/` | rollout page: percentages, allow/block lists, preview | S2 Habiba |
| `src/audit/` | audit log, CSV export, monitoring page, alerts | S3 Ebrahim |

`src/apiBase.js` decides where API calls go: the same origin by default, or `VITE_API_BASE` when
the site is served from S3 on Floci.

Run it with `npm run dev:web` from the repo root (port 5173, `/api` is proxied to the API on
port 3000). Security headers (CSP, HSTS and the rest) are set in the root `vercel.json`, not here.
Every permission the UI hides is checked again by the backend.
