#!/usr/bin/env bash
set -euo pipefail
# [3/5] CloudWatch Logs: /aws/ecs/ffm-api, kept 7 days (old logs are deleted, so they never
# pile up and cost money on real AWS). The task definition sends each task's output here.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

echo "=== [3/5] CloudWatch Logs: /aws/ecs/ffm-api ==="
ok awsl logs create-log-group --log-group-name /aws/ecs/ffm-api
awsl logs put-retention-policy --log-group-name /aws/ecs/ffm-api --retention-in-days 7 >/dev/null 2>&1 \
  || echo "  (retention not supported by this Floci version, skipping)"
echo "[3/5] done: /aws/ecs/ffm-api"
