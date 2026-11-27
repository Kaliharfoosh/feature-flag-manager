# Screenshots

Evidence for the Final report. File names are `<owner>-<report section>-<what>.png`.

Terminal images show the **real command and its real output**, captured on 27 Nov 2026 on the Floci deployment (API Gateway id `4a2f509b5e`) and the live Vercel site. No secret appears in any image: secrets are never printed by the scripts, and API keys show only their 14-character display prefix.

## S2 (Habiba): Rollouts & Evaluations

| File | Report section | What it shows |
|---|---|---|
| `s2-06-lambdas.png` | §6.1 AWS Lambda | The four functions on Floci: one per service (`ffm-flags-fn`, `ffm-eval-fn`, `ffm-audit-fn`) plus S3's `ffm-alert-worker`, each with its own role |
| `s2-06-eval-fn-config.png` | §6.1 AWS Lambda | `ffm-eval-fn`: handler, own role `ffm-eval-role`, 512 MB, 15 s, and its settings by name only (no password in the settings) |
| `s2-06-apigw-routes.png` | §6.1 API Gateway | The 19 routes of `ffm-http-api`, including `/keys` (S1) and the evaluation routes (S2) |
| `s2-06-apigw-throttle.png` | §6.1 API Gateway, §8 | Throttle 50 requests/s, burst 100 on `POST /evaluations` and `/evaluations/batch` |
| `s2-06-secrets.png` | §6.1 Secrets Manager | One secret per function (names and descriptions only) |
| `s2-06-secret-policy.png` | §6.1 Secrets Manager, §8 | Resource policy: only `ffm-eval-role` may read `ffm/eval-db` |
| `s2-06-selftest.png` | §6, §13 | `s2-lambdas.sh` self-test: each Lambda reaches Neon through its own secret (`db: ok`), and API Gateway sends 9 paths to the right Lambda (`X-Served-By`) |
| `s2-06-website-selftest.png` | §6 | `s2-website.sh`: frontend built with the gateway address, uploaded to S3, 6 checks ok (site, deep link, API address, bot check, CORS, login config) |
| `s2-06-website-bucket.png` | §6 | Bucket `ffm-web`: website configuration and the uploaded files |
| `s2-06-floci-website-login.png` | §6 | The React frontend served from the S3 website on Floci (`http://ffm-web.s3-website.localhost.floci.io:4566`); status bar shows the API and database healthy |
| `s2-06-vercel-health.png` | §6.2 | Live health check `https://feature-flag-manager-cyan.vercel.app/api/v1/health`: database ok, all three services, the deployed commit |
| `s2-06-vercel-login.png` | §6.2 | The live site's sign-in page |
| `s2-03-acme-store.png` | §3, §13 | The external client (Acme Store, `ffm-demo-shop.vercel.app`) with flag names shown: 10 of 28 features on for shopper u-981 in staging |
| `s2-08-iam-eval-role.png` | §8 least privilege | `ffm-eval-role` may read only its own secret and write only its own log group |
| `s2-08-hsts.png` | §8 secure transport, ST-14 | Live response headers: HSTS, CSP, nosniff, frame-options, referrer and permissions policy |
| `s2-11-eval-logs.png` | §11 | CloudWatch Logs of `ffm-eval-fn`: structured lines with request id, method, path, status and time; no keys |
| `s2-12-unauth-401.png` | §12 ST-01 (API) | No API key / no session: 401 from the right Lambda, for an evaluation, a rollout and `/keys` |
| `s2-12-ratelimit-floci.png` | §12 rate limit, §14 | k6 through API Gateway → `ffm-eval-fn`: exactly 120 × 200 and 30 × 429 with Retry-After |
| `s2-12-envs.png` | §12 ST-06, §13 | Same user and flags with dev, staging and prod keys on the live API: each key gets its own environment's answers (25, 10 and 7 of 28 on) |
| `s2-14-docker.png` | §14 cost | The Floci deployment runs locally in Docker: Floci, Floci Dash and one container per Lambda |
| `s2-stmt-tests.png` | S2 statement (tests) | Rollouts & Evaluations tests without a database: 5 suites, 98 tests passed |

## S3 (Ebrahim): Audit, Alerts, Monitoring

Captured on Habiba's Floci (the same `s3-audit.sh` deployment), for Ebrahim to use.

| File | Report section | What it shows |
|---|---|---|
| `s3-06-queues.png` | §6.1 Amazon SQS | `ffm-alerts-queue`, `ffm-alerts-dlq` and `ffm-ops-inbox` |
| `s3-06-sns.png` | §6.1 Amazon SNS | Topic `ffm-ops-alerts` and its SQS subscription |
| `s3-06-scheduler.png` | §6.1 EventBridge Scheduler | `ffm-alert-sweeper` (every 10 minutes) and `ffm-daily-audit-summary` (06:00 UTC) |
| `s3-11-alarm-config.png` | §11 CloudWatch | Alarm `ffm-failed-logins`: FailedLogins ≥ 5 in 300 s → SNS |
| `s3-11-alarm-history.png` | §11 suspicious activity | The alarm went OK → ALARM at 03:40:05 after 6 failed logins, then back to OK at 03:55 |
| `s3-monitoring-*.png` | §11 | Ebrahim's own monitoring page screenshots (committed in PR #53) |

## Still to capture by hand (signed in)

These need a signed-in browser, so they are taken by the student who owns them: rollout page, preview, allow/block lists, saving a rollout, the Keys page and ST-07 (revoked key → 401), the Floci site signed in, the monitoring page, the audit log with `rate_limit.hit`, MFA pages, the Vercel dashboard. See the full list in the team's screenshot list.
