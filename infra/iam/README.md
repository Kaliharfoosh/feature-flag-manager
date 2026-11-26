# IAM for the Floci deployment

| Word | Meaning | Ours |
|---|---|---|
| Role | The badge. A service "wears" it to get permission. | 5 roles, listed below |
| Trust policy | WHO may wear the badge. | Lambda roles: only the Lambda service (`trust-policy.json`). Lab 8 roles: only ECS tasks. |
| Permissions policy | WHAT the badge opens. | One policy per role, naming the exact secret and log group |
| Resource policy | A second lock on the secret itself: WHO may open it. | One per secret, naming only its own role |

All roles are created by scripts, never by hand:
`infra/floci/services/s2-lambdas.sh` (the three Lambda roles) and `infra/floci/lab8/02-iam.sh` (Lab 8).
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
| `ffm-ecs-execution-role` | ECS itself, to START a Lab 8 task | `secretsmanager:GetSecretValue` | `arn:aws:secretsmanager:us-east-1:000000000000:secret:ffm/load-test-config*` | ECS injects this one secret (the throwaway load-test database) into the container. |
| | | `logs:CreateLogStream`, `logs:PutLogEvents` | `arn:aws:logs:us-east-1:000000000000:log-group:/aws/ecs/ffm-api:*` | Sends the container's output to its own log group. |
| `ffm-ecs-task-role` | Our code while it runs in a Lab 8 task | **none** | — | The API only talks to Postgres, so it needs no AWS rights. If the code were taken over, it could not read secrets or touch any AWS service. |

Policy names: `ffm-flags-fn-access`, `ffm-eval-fn-access`, `ffm-audit-fn-access` and `ffm-ecs-execution-policy`.

The `-*` at the end of a secret ARN is needed because AWS adds 6 random characters to every
secret's ARN. It matches only that one secret's name, not any other secret.

The log groups are created by the script before the function runs, so no role needs `logs:CreateLogGroup`.

## Second lock: resource policies on the secrets

| Secret | Holds | Only this role may read it |
|---|---|---|
| `ffm/flags-db` | `ffm_app` database login + session secret | `arn:aws:iam::000000000000:role/ffm-flags-role` |
| `ffm/eval-db` | `ffm_app` database login + session secret | `arn:aws:iam::000000000000:role/ffm-eval-role` |
| `ffm/audit-db` | `ffm_app` database login + session secret | `arn:aws:iam::000000000000:role/ffm-audit-role` |

So a function is stopped twice: its own role does not list the other secrets, and the other
secrets do not list its role. The GitHub token is in none of these secrets, so local Floci tests
cannot open real GitHub issues.

## What NO role can do

- read any secret except its own one
- delete or change anything: no `Delete*`, no `Put*` on secrets, no IAM changes
- use any other AWS service (S3, SQS, KMS, ...)
- use `*` as an action or as a resource

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
and the policies it returns match the table above.

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
