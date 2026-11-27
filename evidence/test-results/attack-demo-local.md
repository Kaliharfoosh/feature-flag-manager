# S3 attack demonstration (tests/security/s3-attack-demo.js)

Target: local stack (http://localhost:3000, throwaway Postgres, Turnstile test keys), run 2026-11-27T02:41:19.752Z.
Never run against production. Each row: the attack, the control that stopped it, expected vs actual, and the request id in the audit log.

| # | Attack | Control | Expected | Actual | Result | Request id |
|---|---|---|---|---|---|---|
| A1 | read /flags with no session | requireAuth | 401 | 401 | PASS | `61257cb9-ab08-46ec-8bf8-3c84eed33e97` |
| A1 | read /audit with no session | requireAuth | 401 | 401 | PASS | `ea9bea13-6fe7-40a8-a14a-ef08676df331` |
| A1 | read /monitoring with no session | requireAuth | 401 | 401 | PASS | `7be1e2b0-6f3f-48d4-929b-9c08c2aeb742` |
| A1 | read /alerts with no session | requireAuth | 401 | 401 | PASS | `c2894928-e102-48a0-a766-e46790fdeaf5` |
| A2 | login with no Turnstile token (a bot) | Turnstile | 403 | 403 | PASS | `0b4be7ea-81b2-4325-9398-778fbd6fc7de` |
| A3 | Developer GET /monitoring | requireRole + access.denied | 403 | 403 | PASS | `28590423-f3de-4c87-990b-ecb626cc2d12` |
| A3 | Developer GET /audit/export.csv | requireRole + access.denied | 403 | 403 | PASS | `a2b77bd3-97f2-44d7-bdad-020f1c5c0462` |
| A3 | Developer GET /alerts | requireRole + access.denied | 403 | 403 | PASS | `58b48b85-9c2a-4bb2-b6fa-09e0c61daf49` |
| A3 | Developer PUT /alert-rules | requireRole + access.denied | 403 | 403 | PASS | `9951714c-b4ed-4a02-a310-7714f18ec7c5` |
| A3 | Developer PATCH /flags/:id/environments/prod | requireRole + access.denied | 403 | 403 | PASS | `d1d456b5-c828-492b-905f-46d1f4fc5ddc` |
| A3 | Developer DELETE /flags/:id | requireRole + access.denied | 403 | 403 | PASS | `33f67591-d83f-4014-a851-1090189371bb` |
| A4 | Admin cookie, no X-CSRF-Token (forged request) | csrf-sync | 403 | 403 | PASS | `e0ea3bcc-40ce-48fb-b43b-1acacd9550e5` |
| A4 | Admin cookie, guessed CSRF token | csrf-sync | 403 | 403 | PASS | `632bc7bc-2996-47b3-bfbc-33c9d93f367d` |
| A5 | Globex reads Acme's flag by id | team_id from session | 404 | 404 | PASS | `98b09636-9d0c-404d-be1b-775d838ef96d` |
| A5 | Globex toggles Acme's flag in prod | team_id from session | 404 | 404 | PASS | `aa2a45f7-6ec7-4d98-8e82-3dc0285f6824` |
| A5 | Globex searches the audit log for Acme's admin | team_id from session | 200, 0 rows | 200 | PASS | `ce9507ae-b55b-47b6-bda9-61242c62397b` |
| A6 | GET /audit?actor=' OR '1'='1 | parameterised SQL + zod | 200, 0 rows | 200 | PASS | `f28b6387-2017-41f6-bec9-8cb0f0e42d7b` |
| A6 | GET /audit?action=flag.toggled'; DROP TABLE audit_ev | parameterised SQL + zod | 400 | 400 | PASS | `a0758bfb-d95b-43bc-b3fc-f863393976ef` |
| A6 | GET /flags?q=%' OR 1=1 -- | parameterised SQL + zod | 200, 0 rows | 200 | PASS | `f4aebf76-d3a0-4e03-803f-0ef4423059f8` |
| A6 | POST /alerts/1 OR 1=1/github-issue | parameterised SQL + zod | 400 | 400 | PASS | `87cad7d6-c2ba-4dc4-ba4f-befff9c3933e` |
| A6 | audit_events still exists after the DROP attempt | (proof) | 200 | 200 | PASS | `5f301d12-254c-4c6f-8fe3-357d14714631` |
| A7 | POST /flags with teamId/team_id/role in the body | extra fields dropped, team from session | 201 + 404 | 201 | PASS | `d9e9c024-22fd-4bfc-a84b-4664b7456e99` |
| A8 | flag name is an <img onerror> payload | stored as text, React escapes | 201 | 201 | PASS | `cfd0c060-1a9f-46aa-804f-578bb3938662` |
| A8 | export CSV: no cell starts with = + - @ | csv.cell() neutralises | 200, 0 cells | 200 | PASS | `63e795be-334b-4798-b662-83401082e55c` |
| A9 | forged API key | hashed key lookup | 401 | 401 | PASS | `ebc37711-1833-4018-930f-5226f1ce986e` |
| A9 | valid staging key asks for env=prod in the body | env comes from the key only | 400 | 400 | PASS | `cdfc5c1e-fb12-4a05-ac47-59111e2d417d` |
| A9 | flood: 125 evaluations in a minute (first 429 at #121) | per-key limit 120/min | 429 | 429 | PASS | `841d0eef-dde1-486b-b189-39f447eee496` |
| A10 | GET /.env | no such route, no stack trace | 4xx, no leak | 404 | PASS | `18117e07-dac8-4adb-bb99-35c988d2a044` |
| A10 | GET /.git/config | no such route, no stack trace | 4xx, no leak | 404 | PASS | `6e089e0a-7ebd-4139-a7b1-7d0ba6836dd4` |
| A10 | GET /api/v1/../../etc/passwd | no such route, no stack trace | 4xx, no leak | 404 | PASS | `5bca3a41-447c-4a34-a74f-12735bf0bb93` |
| A10 | GET /api/v1/admin | no such route, no stack trace | 4xx, no leak | 404 | PASS | `20b03513-591b-4d28-bab3-836a8bc34716` |
| A10 | GET /wp-login.php | no such route, no stack trace | 4xx, no leak | 404 | PASS | `e8cbb15c-ddf1-4f2f-91d0-50afc3c8af8e` |
| A11 | invalid JSON body | json parser -> 400 | 400 | 400 | PASS | `4cd1d09b-00dc-402b-93ff-41e55c518aea` |
| A11 | 20 kB body (limit 10 kB) | express.json limit | 413 | 413 | PASS | `e409ce44-1cab-4b7e-b5ac-b8d0aa6e66a8` |
| A11 | text/plain body (CSRF-style form post) | require-json -> 415 | 415 | 415 | PASS | `341aa832-7583-429b-8891-11386cbe5da4` |
| A12 | reuse a session cookie after the user signed out | session destroyed server-side | 401 | 401 | PASS | `810982b6-2e00-456b-87ec-4bdb1d97f680` |
| A13 | 12 wrong passwords (locked out from attempt #6) | login_attempts lockout | 429 | 429 | PASS | `b279ba8e-6f91-4c13-a976-d171cdd39e78` |
| A13 | the RIGHT password while locked out | lockout holds 15 minutes | 429 | 429 | PASS | `be9dbbbf-600b-45fc-9910-2a86b44174b0` |
| A13 | login_failures alert raised for the team | alerts.raiseFor (10 in 15 min) | alert | alert | PASS | `5f29d904-3044-479a-bcc8-2dd4f0a9fc21` |

**39 of 39 attacks were stopped as expected.**

Monitoring right after (last hour, team Acme): failed logins 26, refused (403) 19, bot checks failed 3, rate limited 18, server errors 0.
Most refused endpoints: GET /api/v1/audit/export.csv x3, GET /api/v1/monitoring x3, DELETE /api/v1/flags/c4453878-56a7-4974-bea4-fc1d018c9c81 x2, GET /api/v1/alerts x2, PATCH /api/v1/flags/c4453878-56a7-4974-bea4-fc1d018c9c81/environments/prod x2, PUT /api/v1/alert-rules x2.
Screenshot: the Monitoring page in the 1-hour window with Live on (threat level High).
