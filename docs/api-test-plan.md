# API Test Plan: Feature Flag Manager

Written before the routes, as in Lab 3. Every row can be traced to a rule in
[api-contract.md](api-contract.md). When a service is built, its owner runs the rows and fills in
**Actual result** and **Pass/Fail**. A failing row is information, not something to hide: find the
file that produces the code (see the last table in the contract), fix it, run again, update the row.

How the tests are run:

- **WebStorm HTTP Client**: `tests/http/<service>.http`, one request per row, run with one click.
- **Postman**: the integrated collection, exported to `evidence/postman/`. Run it against
  `http://localhost:3000` first, then against `https://feature-flag-manager-cyan.vercel.app`.
- **Jest + Supertest**: `backend/services/<service>/__tests__/`, run by `npm test` and by CI.

Seed data (`npm run seed`): team **Acme Web** with `admin@acme.test` (Admin) and `dev@acme.test`
(Developer); team **Globex** with `admin@globex.test`. Flags `new-checkout`, `dark-mode`,
`search-v2` (archived). The password is `SEED_PASSWORD` from `.env`.

Columns: **ID** · **Request** · **Expected** · **Actual result** · **Pass/Fail**

---

## Shared behaviour (all)

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| G-01 | `GET /api/v1/health` | 200 `{ status: "ok", db: "ok", commit }` | | |
| G-02 | `GET /api/v1/health` with `DATABASE_URL` pointing at a dead host | 503 `{ status: "degraded", db: "down" }`, not 500 | | |
| G-03 | `PATCH /api/v1/fake-url` | 404 `ROUTE_NOT_FOUND` in the standard shape | | |
| G-04 | `POST /api/v1/flags` with `Content-Type: text/plain` | 415 `UNSUPPORTED_MEDIA_TYPE` | | |
| G-05 | `POST /api/v1/flags` with a trailing comma in the JSON | 400 `VALIDATION_ERROR` "Request body is not valid JSON."; server keeps running | | |
| G-06 | `POST /api/v1/flags` with a 20 kB body | 413 `PAYLOAD_TOO_LARGE` | | |
| G-07 | Any error response | Has `requestId`, and the same id is in the `X-Request-Id` header and in one log line | | |
| G-08 | Any response | Has `X-Content-Type-Options: nosniff` and no `X-Powered-By` | | |

## S1 · Identity

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| AUTH-01 | `POST /auth/login` admin, correct password | 200 with `user.role = "admin"`; `Set-Cookie ffm.sid` is HttpOnly, SameSite=Strict (Secure on Vercel) | | |
| AUTH-02 | `POST /auth/login` wrong password | 401 `UNAUTHENTICATED`; message does not say whether the email exists | | |
| AUTH-03 | `POST /auth/login` unknown email | 401, identical message and timing class as AUTH-02 | | |
| AUTH-04 | `POST /auth/login` body `{ "email": 5 }` | 400 `VALIDATION_ERROR` naming `email` | | |
| AUTH-05 | 6 wrong passwords in a row for one email | 6th answers 429 `RATE_LIMITED`; `login.failed` events in the audit log | | |
| AUTH-06 | `GET /auth/me` with cookie | 200 with `user` and `csrfToken` | | |
| AUTH-07 | `GET /auth/me` without cookie | 401 | | |
| AUTH-08 | `POST /auth/logout` with cookie + token | 204; the cookie no longer works (`GET /auth/me` → 401) | | |
| AUTH-09 | `POST /auth/logout` with cookie but no `X-CSRF-Token` | 403 `CSRF_INVALID` | | |
| AUTH-10 | Session row in Neon `session` table | Contains no password; disappears after logout | | |

## S1 · Flag Management

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| FLG-01 | `GET /flags` as Developer | 200 `{ items: [...], nextCursor }` with Acme flags only; `search-v2` absent (archived) | | |
| FLG-02 | `GET /flags?archived=true` | 200, `search-v2` present | | |
| FLG-03 | `GET /flags?q=check` | 200, only `new-checkout` | | |
| FLG-04 | `GET /flags?limit=1` then with `cursor` | Two pages, no duplicate, `nextCursor` null on the last | | |
| FLG-05 | `GET /flags?limit=500` | 400 | | |
| FLG-06 | `GET /flags/:id` for a seeded flag | 200, complete flag with three environments | | |
| FLG-07 | `GET /flags/:id` with a random uuid | 404 `NOT_FOUND` | | |
| FLG-08 | `POST /flags` `{ key: "beta-search", name: "Beta search" }` | 201, all environments `enabled: false`, `percentage: 0`, `version: 1` | | |
| FLG-09 | `POST /flags` with the same key again | 409 `CONFLICT` | | |
| FLG-10 | `POST /flags` `{ key: "Bad Key!", name: "" }` | 400 naming the first failing field | | |
| FLG-11 | `POST /flags` sending `id`, `version`, `createdAt` | 201; server-generated values used, client values ignored | | |
| FLG-12 | `PATCH /flags/:id` `{ name: "Renamed", version: <current> }` | 200, `version` + 1 | | |
| FLG-13 | `PATCH /flags/:id` with the old `version` again | 409 `STALE_VERSION`, row unchanged | | |
| FLG-14 | `PATCH /flags/:id` `{ archived: true, version }` as Developer | 403 `FORBIDDEN`, row unchanged | | |
| FLG-15 | Same as FLG-14 as Admin | 200, `archived: true`; audit `flag.archived` | | |
| FLG-16 | `DELETE /flags/:id` on a non-archived flag as Admin | 409 `CONFLICT` | | |
| FLG-17 | `DELETE /flags/:id` on an archived flag as Admin | 204; `GET` → 404 afterwards | | |
| FLG-18 | `DELETE /flags/:id` as Developer | 403 | | |
| FLG-19 | `PATCH /flags/:id/environments/staging` `{ enabled: true, version }` as Developer | 200 `enabled: true`; audit `flag.toggled` with before/after | | |
| FLG-20 | `PATCH /flags/:id/environments/prod` as Developer | 403 `FORBIDDEN`; audit `access.denied` | | |
| FLG-21 | `PATCH /flags/:id/environments/live` | 400 (unknown env) | | |
| FLG-22 | `PATCH /flags/:id/environments/staging` `{ enabled: "yes" }` | 400 | | |
| FLG-23 | All write routes without `X-CSRF-Token` | 403 `CSRF_INVALID`, nothing written | | |

## S2 · Rollout Service

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| ROL-01 | `GET /rollouts/:flagId` for `new-checkout` | 200: dev 100, staging 25, prod 0 (from the seed) | | |
| ROL-02 | `PUT /rollouts/:flagId/staging` `{ percentage: 50, version: <current> }` as Developer | 200, `percentage: 50`, `version` + 1; audit `rollout.updated` before 25 / after 50 | | |
| ROL-03 | Same with the old `version` | 409 `STALE_VERSION`, row unchanged | | |
| ROL-04 | `{ percentage: 150 }` | 400 "percentage must be a number between 0 and 100", row unchanged | | |
| ROL-05 | `{ percentage: "abc" }` | 400, row unchanged | | |
| ROL-06 | `{ percentage: 33.333 }` | 400 (max 2 decimals) or stored as 33.33, as the contract states; document which | | |
| ROL-07 | `PUT /rollouts/:flagId/prod` as Developer | 403 `FORBIDDEN`, row unchanged, `access.denied` logged | | |
| ROL-08 | `PUT /rollouts/:flagId/prod` as Admin | 200 | | |
| ROL-09 | `PUT /rollouts/<Globex flag id>/dev` as Acme admin | 404 (not 403), nothing written | | |
| ROL-10 | `GET /rollouts/:flagId/staging/rules` | 200 `{ items: [] }` on a fresh flag | | |
| ROL-11 | `POST …/rules` `{ userId: "u-1", kind: "allow" }` | 201 with `id`; audit `rule.added` | | |
| ROL-12 | Same user again with `kind: "block"` | 409 `CONFLICT` | | |
| ROL-13 | `{ userId: "", kind: "maybe" }` | 400 | | |
| ROL-14 | `DELETE /rules/:ruleId` | 204; `GET` list no longer shows it | | |
| ROL-15 | `DELETE /rules/<random uuid>` | 404 | | |
| ROL-16 | `POST /preview` `{ flagKey, env: "staging", userId: "u-1" }` with u-1 allowlisted and percentage 0 | 200 `enabled: true, reason: "allowlisted"` | | |
| ROL-17 | `POST /preview` with u-2 blocklisted and percentage 100 | 200 `enabled: false, reason: "blocklisted"` | | |
| ROL-18 | `POST /preview` on an archived flag | 200 `enabled: false, reason: "archived"` | | |
| ROL-19 | `POST /preview` env `prod` as Developer | 403 | | |
| ROL-20 | Unit: `bucket("new-checkout", "u-981")` called twice | Same number both times, 0–9999 | | |
| ROL-21 | Unit: 10 000 users at 25 % | Between 2 300 and 2 700 enabled; every user enabled at 25 % is still enabled at 50 % | | |
| ROL-22 | Unit: percentage 0 / percentage 100 | Nobody / everybody (except blocklisted) | | |
| ROL-23 | `POST /keys` `{ name: "Storefront staging", env: "staging" }` as Admin | 201 with the full `key` once; `GET /keys` shows only the `prefix` | | |
| ROL-24 | `POST /keys` as Developer | 403 | | |
| ROL-25 | `POST /keys` `{ env: "live" }` | 400 | | |
| ROL-26 | `POST /evaluations` with the staging key, `{ flagKey: "new-checkout", userId: "u-981" }` | 200 `{ env: "staging", enabled: <bool> }`; `lastUsedAt` set | | |
| ROL-27 | `POST /evaluations` with no `Authorization` header | 401 | | |
| ROL-28 | `POST /evaluations` with a made-up key | 401, same message as ROL-27 | | |
| ROL-29 | `POST /evaluations` with a staging key for a flag that is only configured in prod | Evaluates staging only: result reflects the staging settings, never prod | | |
| ROL-30 | `DELETE /keys/:id` then `POST /evaluations` with that key | 204, then 401; audit `key.revoked` | | |
| ROL-31 | 130 evaluations in one minute with one key | The last ones answer 429 `RATE_LIMITED` | | |
| ROL-32 | `POST /evaluations` while the DB is unreachable | 503 `DB_UNAVAILABLE`; the demo client shows the feature off | | |
| ROL-33 | Neon `api_keys` table | Holds `key_hash` and `prefix` only; the raw key appears nowhere | | |

## S3 · Audit and Monitoring

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| AUD-01 | Toggle a flag, then `GET /audit` | 200; newest event first is `flag.toggled` with `before`/`after`, `actorLabel` = the email, `requestId` matches the toggle response header | | |
| AUD-02 | `GET /audit?action=rollout.updated` | Only those events | | |
| AUD-03 | `GET /audit?actor=dev@acme.test` | Only Dina's events | | |
| AUD-04 | `GET /audit?from=2026-11-01&to=2026-11-02` | Events in that window only; empty list is 200 `[]` not 404 | | |
| AUD-05 | `GET /audit?from=yesterday` | 400 | | |
| AUD-06 | `GET /audit?limit=2` then with `cursor` | Two pages, no gap, no duplicate | | |
| AUD-07 | `GET /audit` without cookie | 401 | | |
| AUD-08 | `GET /audit` as Globex admin | Only Globex events; Acme events never appear | | |
| AUD-09 | `GET /audit/summary?days=7` | 200 with `changes`, `securityEvents`, `failedLogins`, `prodChanges`, `alertsOpen` that match a manual count | | |
| AUD-10 | `GET /audit/summary?days=0` | 400 | | |
| AUD-11 | `GET /audit/export.csv` as Admin | 200 `text/csv`, attachment header, one row per event, a `details` cell starting with `=` is prefixed with `'` | | |
| AUD-12 | `GET /audit/export.csv` as Developer | 403 | | |
| AUD-13 | A change made with a key or token in `details` | The stored `details` show `[REDACTED]`, never the secret | | |
| AUD-14 | As `ffm_app`: `UPDATE audit_events SET action = 'x'` / `DELETE FROM audit_events` | Postgres "permission denied" | | |
| AUD-15 | `GET /monitoring` as Admin after AUTH-05 | `failedLogins` ≥ 6 and the IP in `topFailedLoginIps` | | |
| AUD-16 | `GET /monitoring` as Developer | 403 | | |
| AUD-17 | `GET /monitoring?hours=1000` | 400 | | |
| AUD-18 | `PUT /alert-rules` `{ rules: [{ rule: "prod_change", enabled: false }] }` | 200; a following prod change raises no alert | | |
| AUD-19 | `PUT /alert-rules` with `rule: "unknown"` | 400 | | |
| AUD-20 | Admin toggles a prod flag with `prod_change` enabled | An alert row `open` is created for that audit event | | |
| AUD-21 | `POST /alerts/:auditId/github-issue` | 201 `status: "sent"` with `githubIssueNumber`; the issue exists in the repo with no secret in its body | | |
| AUD-22 | Same with `GITHUB_TOKEN` set to a wrong value | 502 `UPSTREAM_FAILED`; alert `failed` with `lastError`; Retry works after fixing the token | | |
| AUD-23 | `POST /alerts/:auditId/github-issue` as Developer | 403 | | |
| AUD-24 | `POST /alerts/999999/github-issue` | 404 | | |
| AUD-25 | Vercel runtime log for AUD-21 | Shows method, path, status, requestId; not the token, not the body | | |

## Security tests (the brief's 8+)

Same IDs as the build plan. Record a screenshot or request id for each row in `evidence/`.

| ID | Test | Request | Expected | Owner | Actual result | Pass/Fail |
|---|---|---|---|---|---|---|
| ST-01 | Unauthenticated access | `GET /flags` with no cookie | 401, no data | S1 | | |
| ST-02 | Wrong role on prod | Developer: `PATCH /flags/:id/environments/prod` | 403, nothing written, denial logged | S1 | | |
| ST-03 | Ownership / other team | Globex user opens an Acme flag id | 404, existence not revealed | S1 | | |
| ST-04 | Missing CSRF token | `PUT /rollouts/…` without `X-CSRF-Token` | 403 | S1 | | |
| ST-05 | Invalid input | `PUT /rollouts/…` with `percentage: 150`, then `"abc"` | 400 with field message, row unchanged | S2 | | |
| ST-06 | Key scope | Staging key, flag enabled only in prod | Evaluates staging: `enabled: false` | S2 | | |
| ST-07 | Revoked key | Revoke a key, then `POST /evaluations` with it | 401 | S2 | | |
| ST-08 | Developer manages keys | Developer: `POST /keys` | 403 | S2 | | |
| ST-09 | Injection / XSS | `q=' OR 1=1--` and a flag description `<img src=x onerror=alert(1)>` | Treated as text: no extra rows, no script runs in the UI | S1 | | |
| ST-10 | Audit tampering | As `ffm_app`: `UPDATE audit_events …` | Postgres "permission denied" | S3 | | |
| ST-11 | Brute-force login | 6+ wrong passwords in a row | 429; failed logins on the monitoring card | S3 | | |
| ST-12 | Developer exports audit | Developer: `GET /audit/export.csv` | 403 | S3 | | |
| ST-13 | Secret exposure review | gitleaks on the full history · search `frontend/dist` for secrets · read logs for tokens and passwords | Nothing found; logs show `[REDACTED]` | All | | |
| ST-14 | Browser security headers | `curl -I https://feature-flag-manager-cyan.vercel.app` and run `document.body.append(Object.assign(document.createElement('script'), { textContent: 'alert(1)' }))` in the Console | CSP, nosniff, DENY, Referrer-Policy, Permissions-Policy, COOP present; "Refused to execute inline script" | S2 | | |

## Persistence and recovery (S2)

| ID | Test | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| PER-01 | Create a flag, redeploy on Vercel, `GET /flags/:id` | Still there with the same id | | |
| PER-02 | Create a flag, wait for Neon to suspend (5 min idle), request again | First request slower, data intact | | |
| PER-03 | `pg_dump` the database, restore into a fresh Neon branch, point `DATABASE_URL` at it, run G-01 and FLG-01 | Both pass on the restored copy | | |
| PER-04 | Promote the previous deployment in Vercel | Old code serves within a minute; data unchanged | | |
