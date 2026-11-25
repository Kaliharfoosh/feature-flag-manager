#!/usr/bin/env bash
set -euo pipefail
# [2/5] IAM: two roles, each with only what it needs (Lab 8: "separate task role and execution role")
#
#   ffm-ecs-execution-role  used by ECS itself to START a task: read our ONE secret (to inject it)
#                           and write the task's logs. Nothing else.
#   ffm-ecs-task-role       used by our CODE while it runs. Our API only talks to Postgres, so it
#                           needs NO AWS permissions at all: the role has no policy. If the code
#                           were taken over, it could not read secrets or touch any AWS service.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

echo "=== [2/5] IAM: ffm-ecs-execution-role, ffm-ecs-task-role ==="
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
ok awsl iam create-role --role-name ffm-ecs-execution-role --assume-role-policy-document "$TRUST"
ok awsl iam create-role --role-name ffm-ecs-task-role --assume-role-policy-document "$TRUST"

EXEC_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadOnlyTheLoadTestSecret",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:us-east-1:${ACCOUNT_ID}:secret:${SECRET_NAME}*"
    },
    {
      "Sid": "WriteOnlyOurLogGroup",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:us-east-1:${ACCOUNT_ID}:log-group:/aws/ecs/ffm-api:*"
    }
  ]
}
JSON
)
awsl iam put-role-policy --role-name ffm-ecs-execution-role \
  --policy-name ffm-ecs-execution-policy --policy-document "$EXEC_POLICY"
echo "[2/5] done: execution role (1 secret + 1 log group), task role (no permissions)"
