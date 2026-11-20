# Postman: Phase 3 integrated tests (lead: Ebrahim)

| File | What it is |
|---|---|
| `ffm-workflow.postman_collection.json` | The whole product end to end, 72 requests, 139 checks (below) |
| `ffm-st11-bruteforce.postman_collection.json` | ST-11 only: wrong passwords until 429. **Run it last**: afterwards this IP can't log in for 15 minutes |
| `ffm-local.postman_environment.json` | Variables. `password` and `stagingKey` are left empty on purpose: never commit them |

Test IDs in request names (ST-xx, AUD-xx, ROL-xx, FLG-xx) are the rows in `docs/api-test-plan.md`.

## What the workflow collection covers

1. **Before signing in:** health, ST-01 (401 with no data), AUD-07, unknown route 404,
   ST-15 login without a Turnstile token → 403 `BOT_CHECK_FAILED` (later counted on the monitoring card).
2. **Admin workflow (the week 6 demo):** log in → create a flag (OFF, 0% everywhere) → duplicate key 409 →
   turn it on in staging → stale version 409 → ST-05 invalid percentage 400 → 25% →
   **the client app evaluates it with the staging API key** → ST-06 env in the body refused →
   unknown key 401 → AUD-01/AUD-02 both changes in the audit log (before/after, actor, requestId) →
   AUD-20 a prod toggle raises a `prod_change` alert → its GitHub issue was attempted (`sent`, or
   `failed` with a reason when no token is set) → AUD-21/22 retry → AUD-24 → ST-17 CSV export where no
   cell starts with `= + - @` → AUD-09/10 summary → AUD-05 → monitoring → AUD-17 →
   ST-04 alert rules without CSRF 403 → AUD-19 → **flag lifecycle:** edit (stale version 409) →
   FLG-15 archive → an archived flag evaluates to off → `flag.archived` audited → restore →
   deleting an active flag 409 → archive + delete 204 → the flag is gone but `flag.deleted` stays in the
   audit log → log out → 401 after logout.
3. **Developer:** can read the audit log and edit a description; ST-12/AUD-12 export 403;
   AUD-16 monitoring 403; ST-02 prod toggle and prod rollout 403; archive and delete 403; AUD-23 retry 403;
   the refusals appear as `access.denied`.
4. **Another team (Globex admin):** ST-03 a foreign flag answers 404 and can't be toggled, edited or
   deleted; AUD-08 none of Acme's events are visible; a foreign alert can't be retried.

### Turnstile (login bot check)

Every login sends `X-Turnstile-Token: {{turnstileToken}}`. Locally (`NODE_ENV=development`) and on Preview
the API uses Cloudflare's **test** key pair, which accepts the dummy token `XXXX.DUMMY.TOKEN.XXXX` (already in
the environment file). The API still calls Cloudflare, so the machine needs internet. **Production uses real
keys, so scripts can't log in there**: run the collections on the local stack or a Preview, and check the
production login by hand in the browser.

Not here: ST-10/AUD-14 (audit tampering) is a database test, `backend/shared/__tests__/audit-grants.db.test.js`,
and runs in CI as `ffm_app`.

## Run it in the Postman app

1. Import the two collections and the environment.
2. In the environment, set `baseUrl` (local `http://localhost:3000`, or the Preview URL), and set
   `password` and `stagingKey` as **current values only** (they then stay on your machine).
   Get a key with `npm run seed:key` (until the keys page exists).
3. Run **ffm-workflow** with the Collection Runner. Run **ffm-st11-bruteforce** last.

## Run it from the command line

```bash
npx newman@6.2.1 run evidence/postman/ffm-workflow.postman_collection.json \
  -e evidence/postman/ffm-local.postman_environment.json \
  --env-var "password=<SEED_PASSWORD>" --env-var "stagingKey=<the key>"
```

## A throwaway local stack (same as CI, never touches Neon)

```bash
docker run -d --name ffm-test-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ffm_test -p 127.0.0.1:5433:5432 postgres:16
docker exec ffm-test-db psql -U postgres -d ffm_test -c "CREATE ROLE ffm_app LOGIN PASSWORD 'local-only'"
# a local env file (NOT .env) with:
#   DATABASE_URL_MIGRATE=postgres://postgres:postgres@127.0.0.1:5433/ffm_test
#   DATABASE_URL=postgres://ffm_app:local-only@127.0.0.1:5433/ffm_test
#   SESSION_SECRET=<any long string>   SEED_PASSWORD=<12+ characters>   NODE_ENV=development
node --env-file=<that file> backend/db/migrate.js
node --env-file=<that file> backend/db/seed.js
node --env-file=<that file> backend/db/seed-key.js staging "Acme Web"   # prints the key once
node --env-file=<that file> backend/server.js                            # API on :3000
```

Re-running ST-11 within 15 minutes needs `DELETE FROM login_attempts` on that local database first.
Remove it with `docker rm -f ffm-test-db`.

## For the evidence pack

`evidence/test-results/postman-workflow-local.txt` is a run against the local stack (all 139 checks
passed). For the final evidence, run the same collection against the **deployed Preview URL** and save that
output and screenshots too, with the request IDs in the security test table.
