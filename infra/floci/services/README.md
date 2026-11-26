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

| Function | Handler | Secret (its IAM role may read only this) | Database login |
|---|---|---|---|
| `ffm-flags-fn` | `backend/lambdas/flags.handler` | `ffm/flags-db` | `ffm_app` (shared, limited) |
| `ffm-eval-fn` | `backend/lambdas/eval.handler` | `ffm/eval-db` | `ffm_eval_app` (its own) once created, else `ffm_app` |
| `ffm-audit-fn` | `backend/lambdas/audit.handler` | `ffm/audit-db` | `ffm_app` (shared, limited) |

## Run it

Docker Desktop running, then from the repo root:

```bash
docker compose -f infra/floci/docker-compose.yml up -d   # Floci
npm run db:service-role -- eval                          # once: database role ffm_eval_app in Neon
bash infra/floci/services/s2-lambdas.sh                  # Git Bash: build + deploy everything
```

**Every run deploys**: it rebuilds `build/lambda.zip` and uploads it to all three functions, so
run it again after any code change. Roles, log groups, secrets and routes are updated, never
duplicated. `SKIP_BUILD=1 bash infra/floci/services/s2-lambdas.sh` reuses the last zip.

It ends with a self-test: each function's health on its own (proves Lambda → Secrets Manager →
Neon), then eight requests through API Gateway, checking the status AND which function answered.

## What `ffm_eval_app` may do (tested on a throwaway Postgres)

| Allowed | Refused by Postgres |
|---|---|
| read/write `rollouts`, `user_rules`, `api_key_usage`; read `flags`, `api_keys`, `users`; add `audit_events` | `login_attempts`, `teams`, `schema_migrations`; UPDATE/DELETE on `audit_events`; DELETE on `flags`; UPDATE on `users` |

## Honest limits (for the report)

- Floci records IAM policies, the secrets' resource policies and the route throttle; its docs do
  not say they are enforced. The database refusals above are real: Neon is a real Postgres.
- `ffm-flags-fn` and `ffm-audit-fn` share the `ffm_app` login. Improvement: one login per
  service, as done for `ffm-eval-fn`.
- The functions talk to the live Neon database, so test with a test flag and a test API key.
