#!/usr/bin/env bash
set -euo pipefail
# Builds everything Lab 8 needs on Floci for our API, in order (each step is safe to re-run):
#   bash infra/floci/lab8/setup.sh
# Needs: Floci running (docker compose -f infra/floci/docker-compose.yml up -d) and the
# throwaway database (powershell -File tests\load\start-local-db.ps1).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! curl -s -o /dev/null --max-time 3 http://localhost:4566/; then
  echo "Floci is not answering on :4566. Start it: docker compose -f infra/floci/docker-compose.yml up -d" >&2
  exit 1
fi
for step in 01-secrets 02-iam 03-cloudwatch-logs 04-elbv2 05-ecs; do
  bash "$DIR/$step.sh"
done
echo
echo "Lab 8 infrastructure ready. Next: node infra/floci/lab8/scale-test.js vertical   (or horizontal 3)"
