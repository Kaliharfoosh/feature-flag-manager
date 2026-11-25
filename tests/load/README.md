# Load tests with k6 (S2 · Lab 8)

How the Rollout Service copes when many client apps ask for flags at once. Lab 8 measures one
server against three behind a load balancer. Our API is serverless (Vercel / Lambda start more
copies by themselves), so here we measure the service itself: response times under normal load,
under a spike, and the per-key rate limit under a burst. Results go in
[docs/load-test-results.md](../../docs/load-test-results.md).

**Never run these against production.** They would use up the free Vercel and Neon limits and
fill the real audit log. Everything below runs on your PC against a throwaway database.

| File | Run | What it does |
|---|---|---|
| `evaluations-load.js` | A (`PROFILE=normal`), B (`PROFILE=spike`) | 20 or 100 virtual users; 70% ask one flag (`POST /evaluations`), 30% ask the store's 28 flags at once (`POST /evaluations/batch`). Pass: p(95) < 500 ms, errors < 5% |
| `evaluations-ratelimit.js` | C | One key fires 150 requests. Pass: at most 120 get 200, the rest get 429 with `Retry-After` |
| `start-local-db.ps1` | setup | Throwaway Postgres in Docker: tables, grants, demo data, prints a staging key |

## Before you start
- Docker Desktop running ("Engine running").
- k6 installed: `k6 version` (install once with `winget install k6 --source winget`).

## Steps (PowerShell, repo root)

**1. Throwaway database** (copy the key it prints at the end):

```powershell
powershell -ExecutionPolicy Bypass -File tests\load\start-local-db.ps1
```

**2. Backend for Runs A and B**, in a second window, with the key limit raised. All k6 users share
one key, so with the normal 120/min k6 would only measure the limiter. The raise is ignored when
`NODE_ENV=production`, so it can never weaken the live site.

```powershell
$env:DATABASE_URL='postgres://ffm_app:local-only@localhost:55432/ffm_load'; $env:NODE_ENV='development'; $env:GITHUB_TOKEN=''; $env:LOG_LEVEL='warn'; $env:EVAL_RATE_LIMIT='100000'; node --env-file=.env backend/server.js
```

**3. Run A and Run B** (first window; paste your key):

```powershell
k6 run -e FFM_KEY=ffm_stg_PASTE_KEY -e PROFILE=normal tests/load/evaluations-load.js
```

```powershell
k6 run -e FFM_KEY=ffm_stg_PASTE_KEY -e PROFILE=spike tests/load/evaluations-load.js
```

Optional, "find the ceiling" (Lab 8's optional challenge): no pauses, up to 200 users:

```powershell
k6 run -e FFM_KEY=ffm_stg_PASTE_KEY -e PROFILE=stress tests/load/evaluations-load.js
```

**4. Run C:** stop the backend (Ctrl+C), start it again **without** `EVAL_RATE_LIMIT`:

```powershell
$env:DATABASE_URL='postgres://ffm_app:local-only@localhost:55432/ffm_load'; $env:NODE_ENV='development'; $env:GITHUB_TOKEN=''; $env:LOG_LEVEL='warn'; Remove-Item Env:EVAL_RATE_LIMIT -ErrorAction SilentlyContinue; node --env-file=.env backend/server.js
```

```powershell
k6 run -e FFM_KEY=ffm_stg_PASTE_KEY tests/load/evaluations-ratelimit.js
```

**5. Clean up:**

```powershell
docker rm -f ffm-loadtest-db
```

## What to screenshot
- The k6 summary of each run (the threshold lines with ✓ and the `http_req_duration` line).
- Run C: the `status_200` / `status_429` counters.
- Never the `.env` file or a terminal line that shows the key.
