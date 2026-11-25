#!/usr/bin/env bash
set -euo pipefail
# [1/5] Secrets Manager: ffm/load-test-config
# The database address and session secret for the load-test copies of the API. It points at the
# THROWAWAY local database, never at Neon (Neon's secret ffm/api-secrets is not touched).
# ECS injects these two values into each task as environment variables (05-ecs.sh), so they are
# never in the code, the task definition or the logs.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"

echo "=== [1/5] Secrets Manager: ${SECRET_NAME} ==="
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
VALUE=$(node -e "console.log(JSON.stringify({ DATABASE_URL: process.argv[1], SESSION_SECRET: process.argv[2] }))" "$LOAD_DATABASE_URL" "$SESSION_SECRET")

if awsl secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  awsl secretsmanager put-secret-value --secret-id "$SECRET_NAME" --secret-string "$VALUE" >/dev/null
  echo "  (exists: new value stored)"
else
  awsl secretsmanager create-secret --name "$SECRET_NAME" \
    --description "Load tests only: throwaway local Postgres + session secret" \
    --secret-string "$VALUE" >/dev/null
fi
echo "[1/5] done: ${SECRET_NAME} (value never printed)"
