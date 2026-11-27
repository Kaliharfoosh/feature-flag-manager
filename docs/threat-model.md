# Threat model: Feature Flag Manager

What could go wrong, what stops it, where that control lives in the code or platform, and which
test proves it. The system itself is described in [`architecture.md`](architecture.md); the test
rows (ST-xx, ROL-xx) are in [`api-test-plan.md`](api-test-plan.md).

## What we protect

| Asset | Why it matters |
|---|---|
| Flag settings, especially `prod` | A wrong change switches a feature on or off for every real user of a client app |
| API keys | A key lets a client app read one team's flags in one environment |
| User accounts and sessions | An Admin session can change `prod` and export the audit log |
| Audit log | The only record of who changed what; needed to investigate an incident |
| Secrets (database login, session secret, GitHub token, Turnstile key) | Each one opens a system on its own |
| Availability of `/evaluations` | Client apps ask on every page load; if it fails they fall back to "off" |

## Attackers we plan for

- **Outsider on the internet**: guesses passwords, scans for exposed files, floods endpoints, tries injection.
- **Holder of a leaked API key**: a key copied from a client app's config or logs.
- **Signed-in Developer** who tries to do Admin things (change `prod`, export the audit log), by mistake or on purpose.
- **User of another team** who tries ids that belong to a different team.
- **A bug or a compromised dependency** in one of our services.

## Threats and controls

| ID | Area | Threat | Controls (where) | Proof |
|---|---|---|---|---|
| **T1** | Identity | **Password guessing / credential stuffing** on `POST /auth/login` | Cloudflare Turnstile checked before the password (`middleware/turnstile.js`) · lockout after 5 failures per email **or** IP in 15 min → `429` (`services/auth/service.js`) · bcrypt, with a dummy hash for unknown emails so timing does not reveal accounts · edge limit FW1: 20 login POSTs per IP per minute → `429` · 10 failures for a team in 15 min raise the `login_failures` alert → GitHub issue · on Floci, `FFM/FailedLogins` ≥ 5 in 5 min → CloudWatch alarm → SNS | ST-11, ST-15, ST-18, issue #7 |
| **T2** | Identity | **Session theft or cross-site request forgery** | Cookie `ffm.sid`: HttpOnly, Secure, SameSite=Strict, 30 min sliding (`build-app.js`) · server-side session store, so sign-out really ends it · `X-CSRF-Token` required on every cookie write (`middleware/csrf.js`) · HSTS forces HTTPS (`vercel.json`) · CSP `connect-src 'self'` | ST-04 |
| **T3** | Access control | **A Developer changes `prod`** (toggle, rollout, allow/block rule) | Admin check for `env = prod` before anything is written: `requireRole('admin')` in `services/keys-evaluation/routes.js` (rollouts, rules) and the role check in `services/flags/service.js` (toggle); the rollout page locks the controls too · the denial is audited as `access.denied` and counted on the monitoring page · every `prod` change by an Admin raises the `prod_change` alert | ST-02, ROL tests for 403 on prod |
| **T4** | Data | **Another team's data by changing an id** (IDOR) | Every query filters by the session's or key's `team_id` · a foreign id gets `404`, never `403`, so its existence is not revealed · tested on flags, rollouts, rules, evaluations and audit | ST-03 |
| **T5** | API | **A leaked staging key used to read `prod`**, or to read other teams' flags | The environment comes **only from the key**; a body with `env` is rejected `400` (`services/keys-evaluation/schema.js`) · the key resolves to one team · only on/off values are returned, never rules or percentages · only the SHA-256 of a key is stored, the full key is shown once · revoked keys get `401` · the demo store keeps its key in its server function and asks only for its fixed flag list | ST-06, ST-07, `npm run check:envs` |
| **T6** | Availability | **Flooding `/evaluations`** to run up cost or slow every client | 120 requests per minute per key, counted in Postgres so every function copy shares one count → `429` + `Retry-After` · only the first refusal per minute is audited, so a flood cannot flood the log · `/evaluations/batch` counts as one request, max 50 flags · API Gateway throttle on Floci (50 req/s, burst 100) · edge rule FW2 logs the traffic; Vercel's platform DDoS protection | k6 run C (exactly 120 × 200, then 429), Lab 8 run across 3 copies |
| **T7** | API / app | **Injection**: SQL, stored XSS, CSV formula injection | Parameterised SQL only · strict zod schemas (unknown fields → `400`), 10 kB body limit, JSON only (`415`) · React escapes output; CSP `script-src 'self'` blocks inline scripts · the CSV export neutralises cells that start with `=`, `+`, `-`, `@` (`services/audit-alerts/csv.js`) · Vercel managed OWASP rules log SQLi/XSS patterns at the edge | ST-05, ST-09, ST-14, ST-17 |
| **T8** | Data / repudiation | **Someone edits or deletes the audit log** to hide what they did | The audit row is written in the same transaction as the change (no change without its record) · `ffm_app` may only INSERT and SELECT `audit_events` and `login_attempts`: no UPDATE, DELETE or TRUNCATE (`backend/db/grants.sql`) · every row carries the `requestId` that also appears in the log line | ST-10 (runs in CI on every push) |
| **T9** | Secrets | **A secret leaks** through the repo, the browser bundle, logs or a screenshot | `.env` is git-ignored; only `.env.example` (names, no values) is tracked · gitleaks scans the **full history** in CI on every push · the request logger never logs bodies; passwords and keys are redacted · secrets are Vercel Sensitive variables, and on Floci one Secrets Manager secret per function with a resource policy naming only its role · the GitHub token is readable only by the alert worker | ST-13, CI job `secrets` |
| **T10** | Cloud config | **An over-privileged identity**: one bug or leaked credential reaches everything | One IAM role per function with exact resource ARNs, no `*` actions (`infra/iam/README.md`) · the app's database login `ffm_app` is not the owner: no DDL, no access to `schema_migrations` · Vercel Deployment Protection: every deployment except the public production URL needs a Vercel login (previews also have `DATABASE_URL`) · `protect-main` ruleset: PR + green CI before merge | IAM table read back from Floci, ST-10, Vercel settings |
| **T11** | Cloud config | **Recon and scanning** for `.env`, `.git`, admin panels | Edge rule FW3 denies `/.env`, `/.git`, `wp-admin`, `wp-login.php`, `phpmyadmin`, `xmlrpc.php` with `403` before the function runs · there are no such files to find (static build only) | ST-19 |
| **T12** | Browser | **Clickjacking or a malicious page** framing or scripting the app | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` · `nosniff`, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy (`vercel.json`) · `helmet()` on API responses | ST-14 |
| **T13** | Monitoring | **Alerts get lost** when GitHub is down, so an attack goes unnoticed | Alerts are saved in the database first; a failed delivery is marked `failed` with the reason and an Admin can retry · on Floci the SQS outbox retries 3 times, then the dead-letter queue keeps it for 14 days, with count and Replay on the monitoring page · the CloudWatch alarm does not depend on GitHub | Floci checks in `infra/floci/services/README.md` |

## Shared responsibility

| Provider (Vercel, Neon, AWS) | Our team |
|---|---|
| Physical security, network and DDoS protection at the edge | Writing, testing and watching the firewall rules |
| Encryption at rest and TLS certificates | Forcing HTTPS (HSTS) and secure cookies |
| Patching the runtime, database engine and platform | Keeping our npm dependencies patched (`npm audit` in CI) |
| Running IAM, Secrets Manager and the WAF engine | Writing least-privilege policies and keeping secrets out of the code |
| Database backups / point-in-time restore (Neon) | Knowing how to restore, and keeping the audit log append-only |

## Residual risks (not fully covered)

| Risk | Why it remains | Improvement |
|---|---|---|
| All services share the `ffm_app` login | Kept simple before the deadline | One database login per service, so a bug in one service cannot reach another's tables |
| Evaluations have no edge rate limit | The Vercel free plan allows one rate-limit rule; it protects login | Paid plan, or the `@vercel/firewall` SDK, for a per-IP limit on `/evaluations` |
| Floci does not prove IAM enforcement | The emulator stores policies but does not document checking them | Run the same scripts against a real AWS account |
| No key management UI yet (`/keys`) | S1's endpoints are not built; keys come from `npm run seed:key` | Build create / list / revoke with audit, then key expiry and rotation |
| No MFA enforced inside the app | Out of scope for the coursework | MFA for Admins inside the app; meanwhile each team member turns on MFA for their GitHub, Vercel and Neon accounts |
| Bot Protection managed rule is off | Could challenge the Acme Store's server calls | Turn it on in Log mode, check, then add a bypass for `/evaluations` |
