# Per-student AWS services on Floci

Each student's component uses its own AWS services on Floci, built by scripts in the Lab 8
style: Git Bash, safe to run again, secrets never printed.

| Script | Student | What it builds |
|---|---|---|
| `s2-lambdas.sh` | S2 Habiba | **all three Lambdas** (`ffm-flags-fn`, `ffm-eval-fn`, `ffm-audit-fn`), each with its own **secret**, **IAM role** and **log group**, plus **API Gateway** `ffm-http-api` routing every path to the right one, with a throttle on evaluations. S2's counted services: Lambda (`ffm-eval-fn`), API Gateway, Secrets Manager. |
| `s1-….sh` | S1 Youssef | to come: S3 snapshots, KMS, EventBridge |
| `s3-….sh` | S3 Ebrahim | to come: SQS + DLQ, CloudWatch alarm, SNS |

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
docker compose -f infra/floci/docker-compose.yml up -d   # Floci
bash infra/floci/services/s2-lambdas.sh                  # Git Bash: build + deploy everything
```

**Every run deploys**: it rebuilds `build/lambda.zip` and uploads it to all three functions, so
run it again after any code change. Roles, log groups, secrets and routes are updated, never
duplicated. `SKIP_BUILD=1 bash infra/floci/services/s2-lambdas.sh` reuses the last zip.

It needs `DATABASE_URL_APP` (the `ffm_app` login) in `.env` and stops with a clear message if that
is missing. It ends with a self-test: each function's health on its own (proves Lambda → Secrets
Manager → Neon), then eight requests through API Gateway, checking the status AND which function
answered. After every check passes it removes the old Lab 7 function `ffm-api` and its role.

## Honest limits (for the report)

- Floci records IAM policies, the secrets' resource policies and the route throttle; its docs do
  not say they are enforced. `ffm_app`'s database limits are real: Neon is a real Postgres.
- All three functions share the `ffm_app` login. Improvement: one database login per service, so
  a bug in one service cannot reach another service's tables.
- The functions talk to the live Neon database, so test with a test flag and a test API key.
