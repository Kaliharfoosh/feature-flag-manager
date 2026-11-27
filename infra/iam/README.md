# IAM for the Floci deployment

| Word | Meaning | Ours |
|---|---|---|
| Role | The badge. A service "wears" it to get permission. | 7 roles, listed below |
| Trust policy | WHO may wear the badge. | Lambda roles: only the Lambda service (`trust-policy.json`). Lab 8 roles: only ECS tasks. |
| Permissions policy | WHAT the badge opens. | One policy per role, naming the exact secret and log group |
| Resource policy | A second lock on the secret itself: WHO may open it. | One per secret, naming only its own role |

All roles are created by scripts, never by hand:
`infra/floci/services/s2-lambdas.sh` (the three Lambda roles), `infra/floci/services/s3-audit.sh`
(the alert worker's role, and the `ffm-alerts-send` policy on the three Lambda roles) and
`infra/floci/lab8/02-iam.sh` (Lab 8).
Account `000000000000` and region `us-east-1` are Floci's defaults.

## All roles

| Role | Used by | Allowed actions | Exact resource (ARN) | Why it needs this, and nothing more |
|---|---|---|---|---|
| `ffm-flags-role` | Lambda `ffm-flags-fn` (S1: auth, flags) | `secretsmanager:GetSecretValue` | `arn:aws:secretsmanager:us-east-1:000000000000:secret:ffm/flags-db-*` | Reads its own database login and the session secret at cold start. It cannot read the other functions' secrets. |
| | | `logs:CreateLogStream`, `logs:PutLogEvents` | `arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/ffm-flags-fn:*` | Writes its own logs. It cannot write to, read or delete any other log group. |
| `ffm-eval-role` | Lambda `ffm-eval-fn` (S2: rollouts, rules, preview, evaluations, health, 404) | `secretsmanager:GetSecretValue` | `arn:aws:secretsmanager:us-east-1:000000000000:secret:ffm/eval-db-*` | Same as above, for its own secret only. The busiest function (evaluations) gets no extra rights. |
| | | `logs:CreateLogStream`, `logs:PutLogEvents` | `arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/ffm-eval-fn:*` | Writes its own logs only. |
| `ffm-audit-role` | Lambda `ffm-audit-fn` (S3: audit, alerts, monitoring) | `secretsmanager:GetSecretValue` | `arn:aws:secretsmanager:us-east-1:000000000000:secret:ffm/audit-db-*` | Same as above, for its own secret only. |
| | | `logs:CreateLogStream`, `logs:PutLogEvents` | `arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/ffm-audit-fn:*` | Writes its own logs only. |
| `ffm-flags-role`, `ffm-eval-role`, `ffm-audit-role` (policy `ffm-alerts-send`, from `s3-audit.sh`) | the three Lambdas, after COMMIT | `sqs:SendMessage` | `arn:aws:sqs:us-east-1:000000000000:ffm-alerts-queue` | Any of them can raise an alert (a prod toggle is in `ffm-flags-fn`), so each may put `{ alertId }` on the outbox. They cannot read, delete or purge messages, or reach any other queue. |
| `ffm-flags-role`, `ffm-eval-role`, `ffm-audit-role` (policy `ffm-metrics-put`, from `s3-audit.sh`) | the three Lambdas, on a security event | `cloudwatch:PutMetricData` | `*` **with the condition** `cloudwatch:namespace = FFM` | Counts failed logins, 403s, failed bot checks and server errors for the alarm. AWS gives `PutMetricData` no resource ARN, so the namespace condition is the limit: no other namespace, and no reading, deleting or changing alarms. |
| `ffm-audit-role` (policy `ffm-dlq-replay`, from `s3-audit.sh`) | Lambda `ffm-audit-fn` (the monitoring page's dead-letter card) | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueAttributes` | `arn:aws:sqs:us-east-1:000000000000:ffm-alerts-dlq` | Counts the team's dead letters and moves them back to the main queue (Replay). Only this function can: flags and eval have no DLQ rights, and the worker cannot touch the DLQ. |
| `ffm-alert-worker-role` | Lambda `ffm-alert-worker` (S3: the outbox processor, triggered by SQS) | `secretsmanager:GetSecretValue` | `arn:aws:secretsmanager:us-east-1:000000000000:secret:ffm/worker-db-*` and `…:secret:ffm/github-token-*` | Its database login and the GitHub token. It is the **only** role that can read the token. |
| | | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueAttributes` | `arn:aws:sqs:us-east-1:000000000000:ffm-alerts-queue` | What the SQS trigger needs to hand it messages and remove the ones it finished. No `SendMessage`, and no access to the DLQ. |
| | | `sqs:SendMessage` | `arn:aws:sqs:us-east-1:000000000000:ffm-alerts-queue` | The sweeper (scheduled) puts stuck alerts back on the queue. |
| | | `sns:Publish` | `arn:aws:sns:us-east-1:000000000000:ffm-ops-alerts` | The daily summary (scheduled). Only this one topic. |
| | | `logs:CreateLogStream`, `logs:PutLogEvents` | `arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/ffm-alert-worker:*` | Writes its own logs only. |
| `ffm-scheduler-role` (policy `ffm-scheduler-invoke`, from `s3-audit.sh`) | EventBridge Scheduler (trust: `scheduler.amazonaws.com` only) | `lambda:InvokeFunction` | `arn:aws:lambda:us-east-1:000000000000:function:ffm-alert-worker` | Runs the two schedules (sweeper, daily summary). It can start this one function and nothing else. |
| `ffm-ecs-execution-role` | ECS itself, to START a Lab 8 task | `secretsmanager:GetSecretValue` | `arn:aws:secretsmanager:us-east-1:000000000000:secret:ffm/load-test-config*` | ECS injects this one secret (the throwaway load-test database) into the container. |
| | | `logs:CreateLogStream`, `logs:PutLogEvents` | `arn:aws:logs:us-east-1:000000000000:log-group:/aws/ecs/ffm-api:*` | Sends the container's output to its own log group. |
| `ffm-ecs-task-role` | Our code while it runs in a Lab 8 task | **none** | — | The API only talks to Postgres, so it needs no AWS rights. If the code were taken over, it could not read secrets or touch any AWS service. |

Policy names: `ffm-flags-fn-access`, `ffm-eval-fn-access`, `ffm-audit-fn-access`, `ffm-alerts-send`,
`ffm-metrics-put`, `ffm-dlq-replay`, `ffm-alert-worker-access`, `ffm-scheduler-invoke` and `ffm-ecs-execution-policy`.

The `-*` at the end of a secret ARN is needed because AWS adds 6 random characters to every
secret's ARN. It matches only that one secret's name, not any other secret.

The log groups are created by the script before the function runs, so no role needs `logs:CreateLogGroup`.

## Second lock: resource policies on the secrets

| Secret | Holds | Only this role may read it |
|---|---|---|
| `ffm/flags-db` | `ffm_app` database login + session secret | `arn:aws:iam::000000000000:role/ffm-flags-role` |
| `ffm/eval-db` | `ffm_app` database login + session secret | `arn:aws:iam::000000000000:role/ffm-eval-role` |
| `ffm/audit-db` | `ffm_app` database login + session secret | `arn:aws:iam::000000000000:role/ffm-audit-role` |
| `ffm/worker-db` | `ffm_app` database login (no session secret: the worker has no HTTP routes) | `arn:aws:iam::000000000000:role/ffm-alert-worker-role` |
| `ffm/github-token` | fine-grained GitHub token (Issues: write, one repo) + `GITHUB_REPO` | `arn:aws:iam::000000000000:role/ffm-alert-worker-role` |

So a function is stopped twice: its own role does not list the other secrets, and the other
secrets do not list its role. The GitHub token is only in `ffm/github-token`: the three web
functions cannot read it, so a bug in the flags or eval code cannot leak it. (On Vercel it is a
Sensitive environment variable, because Vercel runs everything in one function.)

The alert queue has a resource policy too (`s3-audit.sh`): only the three web roles may send, and
only the worker's role may receive or delete. The DLQ's policy names only `ffm-audit-role`.

## What NO role can do

- read any secret except its own one
- delete or change anything: no `Delete*`, no `Put*` on secrets, no IAM changes
- use any AWS service not listed in its row (S3, KMS, ...); only the alert queue is shared, as above
- use `*` as an action, or `*` as a resource without a condition (the one `*`, for `PutMetricData`, is
  limited to the `FFM` namespace)

**Why not one broad admin role?** One bug or one leaked key in any function could then read every
secret, delete the logs that would show the attack, and change IAM to keep access. With one small
role per function, a problem in one service stays in that service.

## Check it yourself (Git Bash, repo root, Floci running)

```bash
source infra/floci/services/_lib.sh      # Floci's test keys + the awsl helper
awsl iam list-roles --query 'Roles[].RoleName' --output text
awsl iam get-role-policy --role-name ffm-eval-role --policy-name ffm-eval-fn-access --query PolicyDocument
awsl iam get-role --role-name ffm-eval-role --query Role.AssumeRolePolicyDocument
awsl secretsmanager get-resource-policy --secret-id ffm/eval-db --query ResourcePolicy --output text
awsl iam list-role-policies --role-name ffm-ecs-task-role     # empty on purpose
```

None of these print a secret value. Checked on 27 Nov 2026: Floci lists exactly these 5 roles,
and the policies it returns match the table above. (`ffm-alert-worker-role` was added the same
day by `s3-audit.sh`.)

## Database side

IAM guards the AWS side; the database has its own lock. All three Lambdas and Vercel log in to
Neon as `ffm_app` (see `backend/db/grants.sql`). It is not the owner: it cannot create, change or
drop tables, cannot edit or delete audit history or login attempts, and cannot touch
`schema_migrations`. The ST-10 test (`backend/shared/__tests__/audit-grants.db.test.js`) proves
these refusals on every CI run. A separate database login per service is a possible future
improvement and is not done.

## Floci vs real AWS

Floci stores these policies, but its docs do not say that it checks them, and by default any
non-empty credentials work (Lab 7). On real AWS every call is checked, and anything not listed
here gets `AccessDeniedException`. So the evidence for IAM is the policies themselves (read them
back with the commands above), not a live "denied" message. Postgres does refuse for real, which
is why the database denials are shown live.

## History

- `ffm-api-role` with policy `ffm-api-access` (`ffm-api-policy.json`) was Lab 7's single function
  for the whole backend. `s2-lambdas.sh` deleted the role on 27 Nov 2026 after the three new
  functions passed their self-test. The JSON file is kept only as a record of Lab 7. Its log
  rights used `"Resource": "*"`, which the new roles no longer do.

## Teammates: adding permissions

When S1 (S3 snapshots, KMS, EventBridge) or S3 (SQS, SNS, CloudWatch) give their function a new
AWS right, add it to that role's policy in the script **and** add a row to the table above with
the exact ARN. Never use `"Resource": "*"`.
