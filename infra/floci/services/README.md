# Per-student AWS services on Floci

Each student's component uses its own AWS services on Floci, built by scripts in the Lab 8
style: Git Bash, safe to run again, secrets never printed.

| Script | Student | What it builds |
|---|---|---|
| `s2-lambdas.sh` | S2 Habiba | **all three Lambdas** (`ffm-flags-fn`, `ffm-eval-fn`, `ffm-audit-fn`), each with its own **secret**, **IAM role** and **log group**, plus **API Gateway** `ffm-http-api` routing every path to the right one, with a throttle on evaluations. S2's counted services: Lambda (`ffm-eval-fn`), API Gateway, Secrets Manager. |
| `s2-website.sh` | S2 Habiba | the React frontend as the **S3** static website `ffm-web` (http://ffm-web.s3-website.localhost.floci.io:4566), built with the API Gateway address. Website hosting with `index.html` for every route, a read-only public policy (public ACLs stay blocked), and a self-test (site, deep link, API address, bot check, CORS, login config). Run it **after** `s2-lambdas.sh`, and again after any frontend change. |
| `s1-flags.sh` | S1 Youssef | versioned private S3 snapshots, KMS encryption, production EventBridge events to S3's existing SNS topic, and local SES notices for production API-key creation/revocation. Runs after `s2-lambdas.sh` and `s3-audit.sh`; updates only `ffm-flags-fn` and `ffm-flags-role`. SES sender defaults to `security@ffm.local`; override with `SES_FROM_ADDRESS`. Recipients are the team's Admin users. Floci captures mail locally. |
| `s3-audit.sh` | S3 Ebrahim | the **alert outbox**: **SQS** `ffm-alerts-queue` + `ffm-alerts-dlq` (after 3 tries), processed by Lambda `ffm-alert-worker`; **CloudWatch** alarm `ffm-failed-logins`; **SNS** topic `ffm-ops-alerts` (+ `ffm-ops-inbox` queue subscribed, to show delivery). The GitHub token moves to `ffm/github-token`, readable only by the worker. Run it **after** `s2-lambdas.sh`. S3's counted services: SQS, CloudWatch, SNS, plus **EventBridge Scheduler** (`ffm-alert-sweeper` every 10 min, `ffm-daily-audit-summary` at 06:00 UTC) as a 4th. |

S2 owns the Lambda setup and the API Gateway route table for the whole team, so S1 and S3 only add
their own other services.

## How one API reaches three Lambdas

`backend/build-app.js` builds the Express app with only the services a Lambda asks for. API
Gateway picks the most specific route:

```
/api/v1/auth/*, /api/v1/flags, /api/v1/flags/*                 ──► ffm-flags-fn  (S1 code)
/api/v1/evaluations(+/batch), /rollouts/*, /rules/*, /preview  ──► ffm-eval-fn   (S2 code)
/api/v1/health and every unknown path (404)                    ──► ffm-eval-fn   (S2 owns operations)
/api/v1/audit(/*), /monitoring, /alert-rules, /alerts(/*)      ──► ffm-audit-fn  (S3 code)
```

Every response carries `X-Served-By` (`flags`, `eval` or `audit`). All three use the same session
secret, so one login works everywhere.

| Function | Handler | Secret (its IAM role may read only this) |
|---|---|---|
| `ffm-flags-fn` | `backend/lambdas/flags.handler` | `ffm/flags-db` |
| `ffm-eval-fn` | `backend/lambdas/eval.handler` | `ffm/eval-db` |
| `ffm-audit-fn` | `backend/lambdas/audit.handler` | `ffm/audit-db` |

All three log in to Neon as `ffm_app`, the limited login Vercel also uses (no DDL, audit history
append-only, no access to the migration table).

## Run it

Docker Desktop running, then from the repo root:

```bash
docker compose -f infra/floci/docker-compose.yml up -d
bash infra/floci/services/s2-lambdas.sh
bash infra/floci/services/s3-audit.sh
bash infra/floci/services/s1-flags.sh
bash infra/floci/services/s2-website.sh
node infra/floci/services/capture-evidence.js
```

Each student's script remains separate. S1's `s1-flags.sh` runs after S2's Lambdas
and S3's SNS topic are ready. The final read-only command writes
`evidence/test-results/floci-services.json` with resource names and statuses,
without secret values. Run it again to refresh the evidence after any deployment.
Run `s2-website.sh` after frontend changes to rebuild the hosted site.

Run `s1-flags.sh` after `s2-lambdas.sh` and `s3-audit.sh`. If Habiba reruns `s2-lambdas.sh`, run
`s1-flags.sh` again afterward to restore S1's Lambda settings and permissions. The S1 script
preserves unrelated environment variables and attaches a separate SES policy to `ffm-flags-role`.
SES identities are verified only inside Floci; no real email is sent.

**Every run deploys**: it rebuilds `build/lambda.zip` and uploads it to all three functions, so
run it again after any code change. Roles, log groups, secrets and routes are updated, never
duplicated. The legacy `ffm-api` Lambda and role are kept by default; set
`CLEANUP_LEGACY=1` only when you intentionally want the script to remove them after its checks.
`SKIP_BUILD=1 bash infra/floci/services/s2-lambdas.sh` reuses the last zip.

It needs `DATABASE_URL_APP` (the `ffm_app` login) in `.env` and stops with a clear message if that
is missing. It ends with a self-test: each function's health on its own (proves Lambda → Secrets
Manager → Neon), then nine requests through API Gateway, checking the status AND which function
answered. One of them is `GET /api/v1/auth/config`: it answers 503 if the login bot check has no
keys, which means nobody can log in on Floci. After the checks pass, the old Lab 7 function and
role stay in place unless `CLEANUP_LEGACY=1` was set.

## Honest limits (for the report)

- Floci records IAM policies, the secrets' resource policies and the route throttle; its docs do
  not say they are enforced. `ffm_app`'s database limits are real: Neon is a real Postgres.
- All three functions share the `ffm_app` login. Improvement: one database login per service, so
  a bug in one service cannot reach another service's tables.
- The functions talk to the live Neon database, so test with a test flag and a test API key.
- Login on Floci uses Cloudflare's published Turnstile **test** keys (they always pass), set on
  `ffm-flags-fn` with `NODE_ENV=development`, because the real Turnstile widget only works on the
  hostnames registered with Cloudflare (the Vercel site). So the bot check is real on Vercel and
  only simulated on Floci; the account lockout (5 failures in 15 minutes) still applies on Floci.

## S3: the alert outbox (`s3-audit.sh`)

```
ffm-flags-fn / ffm-eval-fn / ffm-audit-fn          (any of them can raise an alert)
   │ COMMIT, then SendMessage {alertId}            ← ALERTS_QUEUE_URL is set on all three
   ▼
SQS ffm-alerts-queue ──trigger, batch 1──► Lambda ffm-alert-worker ──► GitHub issue
   │ 3 failed tries                                 (reads ffm/worker-db + ffm/github-token)
   ▼
SQS ffm-alerts-dlq  (kept 14 days) ◄──count / Replay── ffm-audit-fn (monitoring page, Admin)

shared/metrics.js (in all three functions, METRICS_NAMESPACE=FFM)
   │ PutMetricData on every security event
   ▼
CloudWatch FFM/FailedLogins · Forbidden · BotCheckFailures · ServerErrors
   │ alarm ffm-failed-logins: FailedLogins ≥ 5 in 5 min
   ▼
SNS ffm-ops-alerts ──► ffm-ops-inbox (SQS subscriber, to show delivery)
   ▲
   │ daily summary (all teams, counts only)
EventBridge Scheduler ──(role ffm-scheduler-role)──► ffm-alert-worker
   ffm-daily-audit-summary  cron(0 6 * * ? *)  {"task":"daily-summary"}
   ffm-alert-sweeper        rate(10 minutes)   {"task":"sweep"}  ──► stuck alerts back on ffm-alerts-queue
```

- The request only queues the alert id and answers (89 ms for a prod toggle, against about
  1.3 s when GitHub is called inside the request).
- The worker **throws** when GitHub fails, so SQS offers the message again after 60 s; after the
  3rd failure it moves to the DLQ. The alert row says `failed` with the reason, and an Admin can
  still retry it.
- A message delivered twice is safe: the worker claims the alert row first, so the second copy
  finds nothing to claim and is dropped (`"status":"skipped"` in the log).
- If the queue cannot be reached, the request sends the issue inline instead (about 2 s), so no
  alert waits forever. On **Vercel** `ALERTS_QUEUE_URL` is not set and delivery is inline, as before.
- Metrics are counted where the audit log records the event (`shared/audit.js`), so all
  services count the same way. A failed login is counted only after its row is saved; a 403 or
  server error is counted even when the database is down. CloudWatch being down costs a request
  at most about 0.5 s and is only logged (`metrics: not sent`). With `METRICS_NAMESPACE` unset
  (Vercel) nothing is sent.
- **Dead letters on the monitoring page:** the "Alert queue" card shows how many of the team's
  alerts are in the DLQ, and **Replay** (Admin, CSRF, audited as `alert.replayed`) puts them back on
  the main queue for 3 more tries. The DLQ is shared, so the audit function reads it in batches,
  keeps only the team's alert ids (checked in the database) and releases the others untouched.
  Only `ffm-audit-fn` has `ALERTS_DLQ_URL` and the DLQ rights. Retry on a single alert is also
  queued on Floci (`202`), because only the worker can read the GitHub token.
- **Scheduler:** the sweeper puts alerts back on the queue that never reached the worker (still
  `open` 2 minutes after they were raised, or `sending` for over 2 minutes). `failed` ones are left
  to SQS and the DLQ. It runs every **10 minutes, not every minute**: Neon's free tier suspends the
  database after 5 idle minutes, and a job more often than that would keep it awake (and using
  compute hours) all day. The daily summary posts the last 24 hours for all teams to
  `ffm-ops-alerts` as numbers only (no emails, IPs or flag names).
- `rate_limit.hit` has no metric here: `FFM/RateLimitHits` is S2's (Habiba's) bonus item.
- `s2-lambdas.sh` keeps `ALERTS_QUEUE_URL` and `METRICS_NAMESPACE` when it redeploys, and
  `s3-audit.sh` adds the permissions as their own policies (`ffm-alerts-send`, `ffm-metrics-put`),
  so the two scripts can run in any order after the first time.

```bash
bash infra/floci/services/s3-audit.sh       # needs DATABASE_URL_APP, GITHUB_TOKEN, GITHUB_REPO in .env
source infra/floci/services/_lib.sh
awsl sqs get-queue-attributes --queue-url http://floci:4566/000000000000/ffm-alerts-dlq --attribute-names ApproximateNumberOfMessages
awsl logs tail /aws/lambda/ffm-alert-worker
awsl lambda invoke --function-name ffm-alert-worker --cli-binary-format raw-in-base64-out --payload '{"task":"daily-summary"}' out.json   # run the summary now
awsl scheduler list-schedules --query 'Schedules[].[Name,State]' --output text
awsl cloudwatch describe-alarm-history --alarm-name ffm-failed-logins --history-item-type StateUpdate
awsl sqs receive-message --queue-url http://floci:4566/000000000000/ffm-ops-inbox   # the alarm's SNS message
```

Checked on 27 Nov 2026 (Floci 2.5.0): the SQS trigger runs the worker; a failing message is offered
3 times and then moved to the DLQ; the alarm changes to ALARM and SNS delivers its message to the
subscribed queue. All of these actually run on Floci, not only recorded. Live test: 6 wrong
passwords → `FFM/FailedLogins` = 6 → alarm OK → ALARM within a minute → SNS message
"ALARM: ffm-failed-logins" in `ffm-ops-inbox`; two Developer requests to `/monitoring` →
`FFM/Forbidden` = 2. Dead letters: Acme's Admin saw 1, Globex's Admin saw 0 and their Replay moved
nothing; Acme's Replay moved 1 (DLQ 1 → 0, worker picked it up), audited `alert.replayed {"count":1}`.
