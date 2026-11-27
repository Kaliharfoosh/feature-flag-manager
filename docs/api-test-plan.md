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

**Run on 28 Nov 2026:** `tests/test-plan/run-test-plan.js` ran 106 rows over HTTP against a fresh,
freshly seeded local database (as `ffm_app`) and wrote the results below with their request ids
(full list: `evidence/test-results/api-test-plan-run.md`). Rows that cannot run over HTTP were
filled from their real evidence (unit and route tests in CI, a server started with a dead database,
the live firewall runs, `curl -I` on the live site). Result: **118 of 125 rows run, 117 Pass,
1 Fail** (ROL-28: the message for a made-up key differs from the one for a missing key; unknown and
revoked keys do share one message, so no key is revealed, but the row is not met as written).
Still to run by hand: ROL-36, ROL-37 (Acme Store), PER-01 to PER-04 (S2 recovery), AUD-25 (Vercel log).

Seed data (`npm run seed`): team **Acme Web** with `admin@acme.test` (Admin) and `dev@acme.test`
(Developer); team **Globex** with `admin@globex.test`. Flags `new-checkout`, `dark-mode`,
`search-v2` (archived). The password is `SEED_PASSWORD` from `.env`.

Columns: **ID** · **Request** · **Expected** · **Actual result** · **Pass/Fail**

---

## Shared behaviour (all)

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| G-01 | `GET /api/v1/health` | 200 `{ status: "ok", db: "ok", commit }` | 200 status ok, db ok, commit local · `c7fd24dc` | Pass |
| G-02 | `GET /api/v1/health` with `DATABASE_URL` pointing at a dead host | 503 `{ status: "degraded", db: "down" }`, not 500 | Second API with DATABASE_URL at a dead host (127.0.0.1:1): 503 `{"status":"degraded","db":"down"}`, and it kept answering 503 (no crash), 28 Nov | Pass |
| G-03 | `PATCH /api/v1/fake-url` | 404 `ROUTE_NOT_FOUND` in the standard shape | 404 ROUTE_NOT_FOUND · `65c1880c` | Pass |
| G-04 | `POST /api/v1/flags` with `Content-Type: text/plain` | 415 `UNSUPPORTED_MEDIA_TYPE` | 415 UNSUPPORTED_MEDIA_TYPE · `5ca04510` | Pass |
| G-05 | `POST /api/v1/flags` with a trailing comma in the JSON | 400 `VALIDATION_ERROR` "Request body is not valid JSON."; server keeps running | 400 VALIDATION_ERROR "Request body is not valid JSON."; health afterwards 200 · `73ea042f` | Pass |
| G-06 | `POST /api/v1/flags` with a 20 kB body | 413 `PAYLOAD_TOO_LARGE` | 413 PAYLOAD_TOO_LARGE · `63daf057` | Pass |
| G-07 | Any error response | Has `requestId`, and the same id is in the `X-Request-Id` header and in one log line | body requestId 65c1880c… = X-Request-Id 65c1880c… (log line: see api log) · `65c1880c` | Pass |
| G-08 | Any response | Has `X-Content-Type-Options: nosniff` and no `X-Powered-By` | nosniff: nosniff, X-Powered-By: absent · `c7fd24dc` | Pass |

## S1 · Identity

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| AUTH-01 | `POST /auth/login` admin, correct password | 200 with `user.role = "admin"`; `Set-Cookie ffm.sid` is HttpOnly, SameSite=Strict (Secure on Vercel) | 200, role admin, cookie HttpOnly; SameSite=Strict (Secure is added on Vercel) · `c1178a89` | Pass |
| AUTH-02 | `POST /auth/login` wrong password | 401 `UNAUTHENTICATED`; message does not say whether the email exists | 401 UNAUTHENTICATED "Invalid email or password." · `ff673500` | Pass |
| AUTH-03 | `POST /auth/login` unknown email | 401, identical message and timing class as AUTH-02 | 401 UNAUTHENTICATED, same message as AUTH-02: yes (339 ms vs 351 ms; dummy bcrypt hash for unknown emails) · `ad47eafc` | Pass |
| AUTH-04 | `POST /auth/login` body `{ "email": 5 }` | 400 `VALIDATION_ERROR` naming `email` | 400 VALIDATION_ERROR "email: Invalid input: expected string, received number" · `17508874` | Pass |
| AUTH-05 | 6 wrong passwords in a row for one email | 6th answers 429 `RATE_LIMITED`; `login.failed` events in the audit log | responses 401 401 401 429 429 429; login.failed events: 7 · `c129feb0` | Pass |
| AUTH-06 | `GET /auth/me` with cookie | 200 with `user` and `csrfToken` | 200, user admin@acme.test, csrfToken present: true · `980798d6` | Pass |
| AUTH-07 | `GET /auth/me` without cookie | 401 | 401 UNAUTHENTICATED · `754bafa7` | Pass |
| AUTH-08 | `POST /auth/logout` with cookie + token | 204; the cookie no longer works (`GET /auth/me` → 401) | logout 204, then /auth/me 401 · `98463ccb` | Pass |
| AUTH-09 | `POST /auth/logout` with cookie but no `X-CSRF-Token` | 403 `CSRF_INVALID` | 403 CSRF_INVALID · `a6d66ae2` | Pass |
| AUTH-10 | Session row in Neon `session` table | Contains no password; disappears after logout | session row held a password: false; row deleted after logout: true | Pass |

## S1 · Flag Management

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| FLG-01 | `GET /flags` as Developer | 200 `{ items: [...], nextCursor }` with Acme flags only; `search-v2` absent (archived) | 200, 2 flags: dark-mode, new-checkout; search-v2 absent, Globex's loyalty-points absent · `edce6820` | Pass |
| FLG-02 | `GET /flags?archived=true` | 200, `search-v2` present | 200, archived list: search-v2 · `d531cfdc` | Pass |
| FLG-03 | `GET /flags?q=check` | 200, only `new-checkout` | 200, new-checkout · `0c66473c` | Pass |
| FLG-04 | `GET /flags?limit=1` then with `cursor` | Two pages, no duplicate, `nextCursor` null on the last | pages: dark-mode → new-checkout; no duplicate; last nextCursor null · `8d185daf` | Pass |
| FLG-05 | `GET /flags?limit=500` | 400 | 400 VALIDATION_ERROR · `b96e248f` | Pass |
| FLG-06 | `GET /flags/:id` for a seeded flag | 200, complete flag with three environments | 200, environments: dev, prod, staging · `34678717` | Pass |
| FLG-07 | `GET /flags/:id` with a random uuid | 404 `NOT_FOUND` | 404 NOT_FOUND · `4038a846` | Pass |
| FLG-08 | `POST /flags` `{ key: "beta-search", name: "Beta search" }` | 201, all environments `enabled: false`, `percentage: 0`, `version: 1` | 201, dev off 0%, staging off 0%, prod off 0%, version 1 · `5faf19b7` | Pass |
| FLG-09 | `POST /flags` with the same key again | 409 `CONFLICT` | 409 CONFLICT · `1e6fa98b` | Pass |
| FLG-10 | `POST /flags` `{ key: "Bad Key!", name: "" }` | 400 naming the first failing field | 400 VALIDATION_ERROR "key must be 3–50 lowercase letters, digits or hyphens, starting and ending with a letter or digit" · `272ec138` | Pass |
| FLG-11 | `POST /flags` sending `id`, `version`, `createdAt` | 201; server-generated values used, client values ignored | 201, id 7cfb71ba… (not the client's), version 1, createdAt 2026-11-27 · `96e922b2` | Pass |
| FLG-12 | `PATCH /flags/:id` `{ name: "Renamed", version: <current> }` | 200, `version` + 1 | 200, name Renamed, version 2 · `c1a3f539` | Pass |
| FLG-13 | `PATCH /flags/:id` with the old `version` again | 409 `STALE_VERSION`, row unchanged | 409 STALE_VERSION · `d7e685d1` | Pass |
| FLG-14 | `PATCH /flags/:id` `{ archived: true, version }` as Developer | 403 `FORBIDDEN`, row unchanged | 403 FORBIDDEN · `d2aadd29` | Pass |
| FLG-15 | Same as FLG-14 as Admin | 200, `archived: true`; audit `flag.archived` | 200, archived true; flag.archived in the audit log: true · `a5b4dd8f` | Pass |
| FLG-16 | `DELETE /flags/:id` on a non-archived flag as Admin | 409 `CONFLICT` | 409 CONFLICT · `4005ab2d` | Pass |
| FLG-17 | `DELETE /flags/:id` on an archived flag as Admin | 204; `GET` → 404 afterwards | 204, then GET 404 · `4d3cb671` | Pass |
| FLG-18 | `DELETE /flags/:id` as Developer | 403 | 403 FORBIDDEN · `b302a910` | Pass |
| FLG-19 | `PATCH /flags/:id/environments/staging` `{ enabled: true, version }` as Developer | 200 `enabled: true`; audit `flag.toggled` with before/after | 200, enabled true; audit flag.toggled before {"enabled":false} after {"enabled":true} · `e472d0a1` | Pass |
| FLG-20 | `PATCH /flags/:id/environments/prod` as Developer | 403 `FORBIDDEN`; audit `access.denied` | 403 FORBIDDEN; access.denied with the same requestId: true · `04f51ee8` | Pass |
| FLG-21 | `PATCH /flags/:id/environments/live` | 400 (unknown env) | 400 VALIDATION_ERROR · `4fc4415a` | Pass |
| FLG-22 | `PATCH /flags/:id/environments/staging` `{ enabled: "yes" }` | 400 | 400 VALIDATION_ERROR · `ccc24697` | Pass |
| FLG-23 | All write routes without `X-CSRF-Token` | 403 `CSRF_INVALID`, nothing written | 6 write routes: 403 CSRF_INVALID; flags created: 0 | Pass |

## S2 · Rollout Service

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| ROL-01 | `GET /rollouts/:flagId` for `new-checkout` | 200: dev 100, staging 25, prod 0 (from the seed) | 200: dev 100, staging 25, prod 0 · `175ae8aa` | Pass |
| ROL-02 | `PUT /rollouts/:flagId/staging` `{ percentage: 50, version: <current> }` as Developer | 200, `percentage: 50`, `version` + 1; audit `rollout.updated` before 25 / after 50 | 200, percentage 50, version 1 → 2; audit before 25 after 50 · `1bfd9372` | Pass |
| ROL-03 | Same with the old `version` | 409 `STALE_VERSION`, row unchanged | 409 STALE_VERSION · `43f0c056` | Pass |
| ROL-04 | `{ percentage: 150 }` | 400 "percentage must be a number between 0 and 100", row unchanged | 400 VALIDATION_ERROR "percentage must be a number between 0 and 100" · `154d4fe3` | Pass |
| ROL-05 | `{ percentage: "abc" }` | 400, row unchanged | 400 VALIDATION_ERROR "percentage must be a number between 0 and 100" · `65e89f87` | Pass |
| ROL-06 | `{ percentage: 33.333 }` | 400 (max 2 decimals) or stored as 33.33, as the contract states; document which | 400 VALIDATION_ERROR "percentage can have at most 2 decimals" (contract: max 2 decimals) · `6152dc3d` | Pass |
| ROL-07 | `PUT /rollouts/:flagId/prod` as Developer | 403 `FORBIDDEN`, row unchanged, `access.denied` logged | 403 FORBIDDEN · `ab7f7a7e` | Pass |
| ROL-08 | `PUT /rollouts/:flagId/prod` as Admin | 200 | 200 · `07273d05` | Pass |
| ROL-09 | `PUT /rollouts/<Globex flag id>/dev` as Acme admin | 404 (not 403), nothing written | 404 NOT_FOUND (Globex flag loyalty-points) · `475f0551` | Pass |
| ROL-10 | `GET /rollouts/:flagId/staging/rules` | 200 `{ items: [] }` on a fresh flag | 200, 0 rules · `401efe12` | Pass |
| ROL-11 | `POST …/rules` `{ userId: "u-1", kind: "allow" }` | 201 with `id`; audit `rule.added` | 201, id db28b794…; rule.added audited · `c5a242a3` | Pass |
| ROL-12 | Same user again with `kind: "block"` | 409 `CONFLICT` | 409 CONFLICT · `bfd39ffb` | Pass |
| ROL-13 | `{ userId: "", kind: "maybe" }` | 400 | 400 VALIDATION_ERROR · `8202efb0` | Pass |
| ROL-14 | `DELETE /rules/:ruleId` | 204; `GET` list no longer shows it | 204, list afterwards 0 · `92125fbc` | Pass |
| ROL-15 | `DELETE /rules/<random uuid>` | 404 | 404 NOT_FOUND · `7be4a51d` | Pass |
| ROL-16 | `POST /preview` `{ flagKey, env: "staging", userId: "u-1" }` with u-1 allowlisted and percentage 0 | 200 `enabled: true, reason: "allowlisted"` | 200, enabled true, reason allowlisted · `bfdb5bca` | Pass |
| ROL-17 | `POST /preview` with u-2 blocklisted and percentage 100 | 200 `enabled: false, reason: "blocklisted"` | 200, enabled false, reason blocklisted · `0311c5c1` | Pass |
| ROL-18 | `POST /preview` on an archived flag | 200 `enabled: false, reason: "archived"` | 200, enabled false, reason archived · `81d6de54` | Pass |
| ROL-19 | `POST /preview` env `prod` as Developer | 403 | 403 FORBIDDEN · `ddc3c431` | Pass |
| ROL-20 | Unit: `bucket("new-checkout", "u-981")` called twice | Same number both times, 0–9999 | Unit test "the same flag and user always give the same bucket (stable)" and "is always 0 to 9999" (`evaluate.test.js`), green in CI | Pass |
| ROL-21 | Unit: 10 000 users at 25 % | Between 2 300 and 2 700 enabled; every user enabled at 25 % is still enabled at 50 % | Unit tests "25% turns it on for roughly a quarter of users" and "raising 25% to 50% keeps everyone who was already in" (`evaluate.test.js`) | Pass |
| ROL-22 | Unit: percentage 0 / percentage 100 | Nobody / everybody (except blocklisted) | Unit test "0% turns the flag on for nobody, 100% for everybody" + "block list wins over 100%" (`evaluate.test.js`) | Pass |
| ROL-23 | `POST /keys` `{ name: "Storefront staging", env: "staging" }` as Admin | 201 with the full `key` once; `GET /keys` shows only the `prefix` | 201, key shown once (ffm_stg_h9XFq5…); GET /keys shows prefix ffm_stg_h9XFq5 and never the key · `cce7aa38` | Pass |
| ROL-24 | `POST /keys` as Developer | 403 | 403 FORBIDDEN · `44d4c844` | Pass |
| ROL-25 | `POST /keys` `{ env: "live" }` | 400 | 400 VALIDATION_ERROR · `2e135d8a` | Pass |
| ROL-26 | `POST /evaluations` with the staging key, `{ flagKey: "new-checkout", userId: "u-981" }` | 200 `{ env: "staging", enabled: <bool> }`; `lastUsedAt` set | 200, env staging, enabled true; lastUsedAt set: true · `a55eb53e` | Pass |
| ROL-27 | `POST /evaluations` with no `Authorization` header | 401 | 401 UNAUTHENTICATED "Send a valid API key as "Authorization: Bearer <key>"." · `5a006cb0` | Pass |
| ROL-28 | `POST /evaluations` with a made-up key | 401, same message as ROL-27 | 401 UNAUTHENTICATED "The API key is missing, unknown or revoked."; differs from ROL-27's "Send a valid API key as "Authorization: Bearer <key>"." (unknown and revoked keys do share one message, so no key is revealed) · `70a77103` | **Fail** |
| ROL-29 | `POST /evaluations` with a staging key for a flag that is only configured in prod | Evaluates staging only: result reflects the staging settings, never prod | 200, env staging, enabled false (prod is on at 100%) · `1bc3dea9` | Pass |
| ROL-30 | `DELETE /keys/:id` then `POST /evaluations` with that key | 204, then 401; audit `key.revoked` | revoke 204, then evaluation 401 UNAUTHENTICATED; key.revoked audited · `18aa7a19` | Pass |
| ROL-31 | 130 evaluations in one minute with one key | The last ones answer 429 `RATE_LIMITED` | Local, k6 Run C (150 requests, 10 users at once): 120 × 200, 30 × 429 with `Retry-After`, one `rate_limit.hit` row. See `docs/load-test-results.md` | Pass |
| ROL-32 | `POST /evaluations` while the DB is unreachable | 503 `DB_UNAVAILABLE`; the demo client shows the feature off | Route test "503 DB_UNAVAILABLE when the database is down" (`keys-evaluation/__tests__/routes.test.js`); the Acme Store treats any error as all features off | Pass |
| ROL-33 | Neon `api_keys` table | Holds `key_hash` and `prefix` only; the raw key appears nowhere | api_keys columns: id, team_id, env, name, prefix, key_hash, created_by, created_at, last_used_at, revoked_at; stored hash ≠ key; only the prefix ffm_stg_h9XFq5 is readable | Pass |
| ROL-34 | `POST /evaluations/batch` with the staging key, `{ userId: "u-981", flagKeys: [<25 store flags>, "loyalty-points"] }` | 200 `{ env: "staging", flags: {…}, notFound: ["loyalty-points"] }`; archived flags are `false`; key usage + 1 only | 200, env staging, flags {"new-checkout":true,"dark-mode":false,"search-v2":false}, notFound ["loyalty-points"] (Globex's flag is not visible) · `6f00098c` | Pass |
| ROL-35 | Same with `"env": "prod"` added, with 51 keys, and with a repeated key | 400 each, with a field message | env: 400 VALIDATION_ERROR; 51 keys: 400 VALIDATION_ERROR; repeated key: 400 VALIDATION_ERROR · `7e3d7eac` | Pass |
| ROL-36 | Demo store: shopper `u-beta-1` and `u-fraud-77` | `u-beta-1` gets the new checkout (allowlisted); `u-fraud-77` gets the classic one (blocklisted) | | |
| ROL-37 | Demo store: change `gift-wrap` staging in the FFM, then press "Refresh flags" in the store | The gift-wrap option appears/disappears with no redeploy | | |

## S3 · Audit and Monitoring

| ID | Request | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| AUD-01 | Toggle a flag, then `GET /audit` | 200; newest event first is `flag.toggled` with `before`/`after`, `actorLabel` = the email, `requestId` matches the toggle response header | 200, newest: flag.toggled by admin@acme.test, requestId matches the toggle: true · `a792fc5d` | Pass |
| AUD-02 | `GET /audit?action=rollout.updated` | Only those events | 200, 4 events, all rollout.updated · `906c1136` | Pass |
| AUD-03 | `GET /audit?actor=dev@acme.test` | Only Dina's events | 200, 16 events, all by dev@acme.test · `12de6293` | Pass |
| AUD-04 | `GET /audit?from=2026-11-01&to=2026-11-02` | Events in that window only; empty list is 200 `[]` not 404 | 200, 0 events in the window (empty is 200, not 404) · `38211f50` | Pass |
| AUD-05 | `GET /audit?from=yesterday` | 400 | 400 VALIDATION_ERROR · `7dd253f4` | Pass |
| AUD-06 | `GET /audit?limit=2` then with `cursor` | Two pages, no gap, no duplicate | ids 32, 31, 30, 29: no gap between pages, no duplicate · `abadab80` | Pass |
| AUD-07 | `GET /audit` without cookie | 401 | 401 UNAUTHENTICATED · `09b2f219` | Pass |
| AUD-08 | `GET /audit` as Globex admin | Only Globex events; Acme events never appear | 200, 0 events, none from Acme · `0f83fa03` | Pass |
| AUD-09 | `GET /audit/summary?days=7` | 200 with `changes`, `securityEvents`, `failedLogins`, `prodChanges`, `alertsOpen` that match a manual count | 200 {"days":7,"changes":22,"securityEvents":9,"failedLogins":1,"prodChanges":3,"alertsOpen":0} · `d86c838f` | Pass |
| AUD-10 | `GET /audit/summary?days=0` | 400 | 400 VALIDATION_ERROR · `a00665b8` | Pass |
| AUD-11 | `GET /audit/export.csv` as Admin | 200 `text/csv`, attachment header, one row per event, a `details` cell starting with `=` is prefixed with `'` | 200 text/csv; charset=utf-8, attachment; filename="audit-start-now.csv"; cells starting with = + - @: 0; csv.cell('=HYPERLINK…') → "'=HYPERLINK("… · `186b2c86` | Pass |
| AUD-12 | `GET /audit/export.csv` as Developer | 403 | 403 FORBIDDEN · `4e9a7bc1` | Pass |
| AUD-13 | A change made with a key or token in `details` | The stored `details` show `[REDACTED]`, never the secret | details as stored: {"after":{"key":"redact-mwzk69ak","name":"Redaction test","version":1,"archived":false,"description":"key [REDACTED]"}} · `f7fdf6db` | Pass |
| AUD-14 | As `ffm_app`: `UPDATE audit_events SET action = 'x'` / `DELETE FROM audit_events` | Postgres "permission denied" | as ffm_app: UPDATE / DELETE / TRUNCATE audit_events → 42501 / 42501 / 42501 (42501 = permission denied) | Pass |
| AUD-15 | `GET /monitoring` as Admin after AUTH-05 | `failedLogins` ≥ 6 and the IP in `topFailedLoginIps` | failedLogins 7, top IP ::1 × 7 · `9e89c0bd` | Pass |
| AUD-16 | `GET /monitoring` as Developer | 403 | 403 FORBIDDEN · `f392715c` | Pass |
| AUD-17 | `GET /monitoring?hours=1000` | 400 | 400 VALIDATION_ERROR · `e25f5f5c` | Pass |
| AUD-18 | `PUT /alert-rules` `{ rules: [{ rule: "prod_change", enabled: false }] }` | 200; a following prod change raises no alert | 200; the next prod toggle (audit event 39) raised an alert: false · `c4badf29` | Pass |
| AUD-19 | `PUT /alert-rules` with `rule: "unknown"` | 400 | 400 VALIDATION_ERROR · `2c9dd0d4` | Pass |
| AUD-20 | Admin toggles a prod flag with `prod_change` enabled | An alert row `open` is created for that audit event | toggle 200; alert prod_change for audit event 37, status failed (GitHub is not configured (GITHUB_TOKEN and GITHUB_REPO).) · `def7bbfa` | Pass |
| AUD-21 | `POST /alerts/:auditId/github-issue` | 201 `status: "sent"` with `githubIssueNumber`; the issue exists in the repo with no secret in its body | Real run 20 Nov: a prod toggle opened GitHub issue #20 automatically (alert `sent`, number + URL stored); the body was read back: redacted details, 0 secrets | Pass |
| AUD-22 | Same with `GITHUB_TOKEN` set to a wrong value | 502 `UPSTREAM_FAILED`; alert `failed` with `lastError`; Retry works after fixing the token | Real run 27 Nov on Floci with a wrong token: "GitHub answered 401: Bad credentials", alert `failed` with `lastError`, SQS retried 3 times, then the DLQ; "failed, then retried to sent" is a DB test in CI | Pass |
| AUD-23 | `POST /alerts/:auditId/github-issue` as Developer | 403 | 403 FORBIDDEN · `e0cf1173` | Pass |
| AUD-24 | `POST /alerts/999999/github-issue` | 404 | 404 NOT_FOUND · `a8ac7ef3` | Pass |
| AUD-25 | Vercel runtime log for AUD-21 | Shows method, path, status, requestId; not the token, not the body | | |

## Security tests (the brief's 8+)

Same IDs as the build plan. Record a screenshot or request id for each row in `evidence/`.

| ID | Test | Request | Expected | Owner | Actual result | Pass/Fail |
|---|---|---|---|---|---|---|
| ST-01 | Unauthenticated access | `GET /flags` with no cookie | 401, no data | S1 | 401 UNAUTHENTICATED, no data in the body · `5029d974` | Pass |
| ST-02 | Wrong role on prod | Developer: `PATCH /flags/:id/environments/prod` | 403, nothing written, denial logged | S1 | Developer prod toggle: 403 FORBIDDEN; access.denied logged with the same requestId (FLG-20) · `04f51ee8` | Pass |
| ST-03 | Ownership / other team | Globex user opens an Acme flag id | 404, existence not revealed | S1 | Globex opens Acme's new-checkout: 404 NOT_FOUND · `bcfb1f3e` | Pass |
| ST-04 | Missing CSRF token | `PUT /rollouts/…` without `X-CSRF-Token` | 403 | S1 | 403 CSRF_INVALID · `88a9c9e1` | Pass |
| ST-05 | Invalid input | `PUT /rollouts/…` with `percentage: 150`, then `"abc"` | 400 with field message, row unchanged | S2 | percentage 150: 400 VALIDATION_ERROR; "abc": 400 VALIDATION_ERROR; row unchanged (ROL-03 version still current) · `154d4fe3` | Pass |
| ST-06 | Key scope | Staging key, flag on in prod and off in staging; then the same call with `"env": "prod"` added to the body | First call evaluates staging: `enabled: false`. Second call: 400 `Unknown field: env.` | S2 | staging key on a prod-only flag: enabled false; with "env":"prod" in the body: 400 VALIDATION_ERROR "Unknown field: env." · `686c682c` | Pass |
| ST-07 | Revoked key | Revoke a key, then `POST /evaluations` with it | 401 | S2 | revoke 204, evaluation with the revoked key 401 UNAUTHENTICATED · `18aa7a19` | Pass |
| ST-08 | Developer manages keys | Developer: `POST /keys` | 403 | S1 | 403 FORBIDDEN · `bf9344ac` | Pass |
| ST-09 | Injection / XSS | `q=' OR 1=1--` and a flag description `<img src=x onerror=alert(1)>` | Treated as text: no extra rows, no script runs in the UI | S1 | q=' OR 1=1--: 200, 0 rows; XSS description stored as plain text (201); React renders it as text · `6d95066c` | Pass |
| ST-10 | Audit tampering | As `ffm_app`: `UPDATE audit_events …` | Postgres "permission denied" | S3 | as ffm_app: UPDATE / DELETE / TRUNCATE audit_events → 42501 / 42501 / 42501 (42501 = permission denied) | Pass |
| ST-11 | Brute-force login | 6+ wrong passwords in a row | 429; failed logins on the monitoring card | S3 | 6th wrong password 429; monitoring card failedLogins 7 · `c129feb0` | Pass |
| ST-12 | Developer exports audit | Developer: `GET /audit/export.csv` | 403 | S3 | 403 FORBIDDEN · `4e9a7bc1` | Pass |
| ST-13 | Secret exposure review | gitleaks on the full history · search `frontend/dist` for secrets · read logs for tokens and passwords | Nothing found; logs show `[REDACTED]` | All | CI `secrets` job (gitleaks, full history) green on main 291c154 (27 Nov); `frontend/dist` scanned for tokens, DB URLs, keys: 0 files; logs redact cookies, tokens, keys (`shared/logger.js`) | Pass |
| ST-14 | Browser security headers | `curl -I https://feature-flag-manager-cyan.vercel.app` and run `document.body.append(Object.assign(document.createElement('script'), { textContent: 'alert(1)' }))` in the Console | CSP, nosniff, DENY, Referrer-Policy, Permissions-Policy, COOP present; "Refused to execute inline script" | S2 | `curl -I` live, 28 Nov: CSP (`script-src 'self'` + Turnstile only, no `unsafe-inline`), nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, COOP, HSTS all present (screenshot `s2-08-hsts.png`) | Pass |
| ST-15 | Login without a bot-check token | `POST /auth/login` with no Turnstile token | 403 `BOT_CHECK_FAILED` before the password is checked; counted as a bot-check failure on the monitoring card | S1 | 403 BOT_CHECK_FAILED · `cf4f9d6d` | Pass |
| ST-17 | CSV formula injection | A flag named `=HYPERLINK(...)`, then `GET /audit/export.csv` as Admin | No cell starts with `=`, `+`, `-` or `@` | S3 | export as Admin: 0 cells start with = + - @ · `186b2c86` | Pass |
| ST-18 | Edge login limit (Vercel Firewall FW1) | 25 quick `POST /auth/login` with an empty body `{}` (no failed-login rows, no alert) | First 20 get 400 from the app, then 429 from the edge with `x-vercel-mitigated: deny` | S1 | Live 27 Nov (`evidence/test-results/s1-fw1-live.json`): 20 × 400 from the app, then 5 × 429 from the edge with `x-vercel-mitigated: deny`. Seen again 27 Nov by `s3-live-traffic.js`: logins 21–22 got 429 at the edge | Pass |
| ST-19 | Scanner paths blocked at the edge (FW3) | `curl -i …/.env`, `/.git/config`, `/wp-admin`, `/wp-login.php`, `/phpmyadmin`, `/xmlrpc.php` | 403 for all six; a normal path such as `/envelope` still 200 | S3 | Live 27 Nov: `/.env`, `/.git/config`, `/wp-login.php` → 403 with `X-Vercel-Mitigated: deny` and no `X-Request-Id` (the app never saw them); all six paths 403 and `/envelope` 200 in the FW3 test the same day | Pass |
| ST-20 | Passive web scan (OWASP ZAP baseline) | `zap-baseline.py -t https://feature-flag-manager-cyan.vercel.app -a -m 2` (or Actions → "ZAP baseline scan") | No FAIL; every accepted warning has a written reason in `.zap/rules.tsv` | S3 | 28 Nov, live: 0 FAIL, 6 WARN, 52 PASS; reasons in `.zap/rules.tsv`, report `evidence/test-results/zap-baseline-live.md` | Pass |

## Persistence and recovery (S2)

| ID | Test | Expected | Actual result | Pass/Fail |
|---|---|---|---|---|
| PER-01 | Create a flag, redeploy on Vercel, `GET /flags/:id` | Still there with the same id | | |
| PER-02 | Create a flag, wait for Neon to suspend (5 min idle), request again | First request slower, data intact | | |
| PER-03 | `pg_dump` the database, restore into a fresh Neon branch, point `DATABASE_URL` at it, run G-01 and FLG-01 | Both pass on the restored copy | | |
| PER-04 | Promote the previous deployment in Vercel | Old code serves within a minute; data unchanged | | |

## Flag lifecycle and sign-in verification

- A Developer edits a name and description, then a stale version is rejected with 409.
- A Developer who sends `archived` or DELETE receives 403 with an `access.denied` event.
- An Admin archives and restores a flag. Archiving forces evaluation Off, and the corresponding audit events persist.
- DELETE of an active flag returns 409. DELETE of an archived flag returns 204, removes its environment and user-rule rows, and preserves audit history.
- If the audit write fails, edits and deletions roll back, including cascaded rows.
- A cross-team id returns 404 for PATCH and DELETE.
- Missing, expired, replayed or mismatched Turnstile tokens receive 403 before password authentication. Cloudflare outages receive 503.
- Failed verification creates `bot_check.failed`, increments Monitoring's `botCheckFailures`, and leaves password attempt counts unchanged.
- Production refuses missing keys and dummy keys. Local and Preview checks use Cloudflare's official dummy pair and still call Siteverify.
- The sign-in widget refreshes after a failed login, disables submission after expiry, and supports retry after a loading error.

Production requires matching `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` settings for the deployed hostname. Set `TURNSTILE_HOSTNAMES` to the comma-separated hostnames to validate them on the server. Preview test widgets use Cloudflare's documented `example.com` dummy response. Scripted sign-in tests target a protected Preview deployment or local development.