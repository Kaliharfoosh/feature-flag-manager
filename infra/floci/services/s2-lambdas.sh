#!/usr/bin/env bash
set -euo pipefail
# S2 (Habiba) on Floci: one Lambda per service behind ONE API Gateway.
# S2 owns the Lambda setup and the API Gateway route table for the whole team, so this script
# builds all three functions. S1 and S3 add their own other AWS services in their own scripts.
#
#   Lambda          ffm-flags-fn   (S1 routes)   ffm-eval-fn (S2 routes)   ffm-audit-fn (S3 routes)
#   Secrets Manager ffm/flags-db   ffm/eval-db   ffm/audit-db   (one per function)
#   IAM             ffm-flags-role ffm-eval-role ffm-audit-role (each reads ONLY its own secret)
#   CloudWatch Logs /aws/lambda/<function>, kept 7 days
#   API Gateway     ffm-http-api: every path -> the right function, throttle on evaluations
#
# S2's 3 counted services: Lambda (ffm-eval-fn), API Gateway, Secrets Manager.
#
# Run from Git Bash, Floci running:   bash infra/floci/services/s2-lambdas.sh
# Every run DEPLOYS: it rebuilds the code and uploads it to all three functions. Anything that
# already exists (roles, log groups, routes) is kept or updated, never duplicated.
# After all self-tests pass it removes the old Lab 7 single function ffm-api (and its role).
# SKIP_BUILD=1 reuses the last build/lambda.zip. Secrets are never printed.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"
cd "$REPO"

# function | service | secret | role
# All three log in to Neon as ffm_app, the limited login Vercel uses (DATABASE_URL_APP in .env):
# no DDL, audit history append-only, no access to the migration table.
SERVICES=(
  "ffm-flags-fn|flags|ffm/flags-db|ffm-flags-role"
  "ffm-eval-fn|eval|ffm/eval-db|ffm-eval-role"
  "ffm-audit-fn|audit|ffm/audit-db|ffm-audit-role"
)

# Which paths go where. API Gateway always picks the MOST specific match.
# The catch-all and /health go to ffm-eval-fn: S2 owns operations (health, unknown paths -> 404).
ROUTES=(
  "ffm-flags-fn|ANY /api/v1/auth/{proxy+}"
  "ffm-flags-fn|ANY /api/v1/flags"
  "ffm-flags-fn|ANY /api/v1/flags/{proxy+}"
  "ffm-eval-fn|POST /api/v1/evaluations"
  "ffm-eval-fn|POST /api/v1/evaluations/batch"
  "ffm-eval-fn|ANY /api/v1/rollouts/{proxy+}"
  "ffm-eval-fn|ANY /api/v1/rules/{proxy+}"
  "ffm-eval-fn|POST /api/v1/preview"
  "ffm-eval-fn|GET /api/v1/health"
  "ffm-eval-fn|ANY /api/{proxy+}"
  "ffm-audit-fn|ANY /api/v1/audit"
  "ffm-audit-fn|ANY /api/v1/audit/{proxy+}"
  "ffm-audit-fn|ANY /api/v1/monitoring"
  "ffm-audit-fn|ANY /api/v1/alert-rules"
  "ffm-audit-fn|ANY /api/v1/alerts"
  "ffm-audit-fn|ANY /api/v1/alerts/{proxy+}"
)

# First layer before the per-key limit (120/min per key, in Postgres): the evaluation routes may
# take 50 requests per second, bursts up to 100. Above that API Gateway answers 429 itself.
THROTTLE_RATE=50
THROTTLE_BURST=100

# Temporary files go in build/ (ignored by git) with a RELATIVE path: the Windows AWS CLI cannot
# open Git Bash paths like /tmp/... . They are always deleted, including secret values.
TMP="build/tmp-s2-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "=== [0/6] Checks ==="
command -v aws >/dev/null || { echo "AWS CLI not found. Install it first."; exit 1; }
awsl sts get-caller-identity >/dev/null 2>&1 \
  || { echo "Floci is not answering on ${ENDPOINT}. Start it:  docker compose -f infra/floci/docker-compose.yml up -d"; exit 1; }
node --env-file=.env -e "process.exit(process.env.DATABASE_URL_APP ? 0 : 1)" \
  || { echo "DATABASE_URL_APP (the ffm_app login) is missing in .env."; exit 1; }
# The session secret must be the SAME in every function, or a login made through ffm-flags-fn
# is not valid in the others. Reuse the one Lab 7's ffm/api-secrets has; else SESSION_SECRET.
awsl secretsmanager get-secret-value --secret-id ffm/api-secrets --query SecretString --output text \
  > "$TMP/shared.json" 2>/dev/null || echo '{}' > "$TMP/shared.json"
ALERTS_QUEUE_URL=$(awsl sqs get-queue-url --queue-name ffm-alerts-queue --query QueueUrl --output text 2>/dev/null || true)
ALERTS_DLQ_URL=$(awsl sqs get-queue-url --queue-name ffm-alerts-dlq --query QueueUrl --output text 2>/dev/null || true)
echo "[0/6] done: Floci is up"

echo "=== [1/6] Build the Lambda code (build/lambda.zip, one zip for all three) ==="
if [ "${SKIP_BUILD:-}" = "1" ] && [ -f build/lambda.zip ]; then
  echo "  (SKIP_BUILD=1: using the existing build/lambda.zip)"
else
  node infra/floci/build-lambda.js
fi
echo "[1/6] done"

# Builds ONE function with its own secret, log group and role.
deploy_function() {
  local fn="$1" service="$2" secret="$3" role="$4"
  local log_group="/aws/lambda/${fn}"
  echo "--- ${fn} (services: ${service}) ---"

  # Secrets Manager: this function's database login + the shared session secret
  node --env-file=.env -e "
    const fs = require('fs');
    let shared = {};
    try { shared = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); } catch {}
    const value = {
      DATABASE_URL: process.env.DATABASE_URL_APP,
      SESSION_SECRET: shared.SESSION_SECRET || process.env.SESSION_SECRET,
    };
    if (!value.SESSION_SECRET) { console.error('No SESSION_SECRET found'); process.exit(1); }
    fs.writeFileSync(process.argv[2], JSON.stringify(value));
  " "$TMP/shared.json" "$TMP/secret.json"
  if awsl secretsmanager describe-secret --secret-id "$secret" >/dev/null 2>&1; then
    awsl secretsmanager put-secret-value --secret-id "$secret" --secret-string "file://$TMP/secret.json" >/dev/null
  else
    awsl secretsmanager create-secret --name "$secret" \
      --description "${fn}: database login + shared session secret" \
      --secret-string "file://$TMP/secret.json" >/dev/null
  fi
  rm -f "$TMP/secret.json"
  # Resource policy: a second lock, only this function's role may read the secret
  cat > "$TMP/secret-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [ { "Sid": "OnlyItsFunction", "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/${role}" },
  "Action": "secretsmanager:GetSecretValue", "Resource": "*" } ] }
JSON
  awsl secretsmanager put-resource-policy --secret-id "$secret" \
    --resource-policy "file://$TMP/secret-policy.json" >/dev/null 2>&1 || true
  echo "  secret      ${secret} (value never printed, readable only by ${role})"

  # CloudWatch Logs
  ok awsl logs create-log-group --log-group-name "$log_group"
  awsl logs put-retention-policy --log-group-name "$log_group" --retention-in-days 7
  echo "  logs        ${log_group} (7 days)"

  # IAM: read ONLY its own secret, write ONLY its own log group
  ok awsl iam create-role --role-name "$role" \
    --assume-role-policy-document file://infra/iam/trust-policy.json \
    --description "${fn}: read ${secret}, write its own logs, nothing else"
  cat > "$TMP/role-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "ReadOnlyItsOwnSecret", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
    "Resource": "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${secret}-*" },
  { "Sid": "WriteOnlyItsOwnLogs", "Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
    "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${log_group}:*" } ] }
JSON
  awsl iam put-role-policy --role-name "$role" --policy-name "${fn}-access" \
    --policy-document "file://$TMP/role-policy.json"
  echo "  role        ${role}"

  # Lambda: create it, or upload the new code and settings (= deploy)
  # ALERTS_QUEUE_URL + METRICS_NAMESPACE (+ ALERTS_DLQ_URL for the audit function only): S3's
  # alert outbox, CloudWatch metrics and dead-letter card (s3-audit.sh). Kept when the queue
  # exists, so a re-run of this script does not switch them off.
  local s3_vars=""
  if [ -n "$ALERTS_QUEUE_URL" ]; then
    s3_vars=",ALERTS_QUEUE_URL=${ALERTS_QUEUE_URL},METRICS_NAMESPACE=FFM"
    [ "$service" = audit ] && [ -n "$ALERTS_DLQ_URL" ] && s3_vars+=",ALERTS_DLQ_URL=${ALERTS_DLQ_URL}"
  fi
  local env_vars="Variables={SECRET_ID=${secret},CORS_ORIGINS=${WEB_ORIGIN}${s3_vars}}"
  if awsl lambda get-function --function-name "$fn" >/dev/null 2>&1; then
    awsl lambda update-function-code --function-name "$fn" --zip-file fileb://build/lambda.zip >/dev/null
    awsl lambda wait function-updated --function-name "$fn" 2>/dev/null || true
    awsl lambda update-function-configuration --function-name "$fn" \
      --handler "backend/lambdas/${service}.handler" --role "arn:aws:iam::${ACCOUNT_ID}:role/${role}" \
      --environment "$env_vars" --memory-size 512 --timeout 15 >/dev/null
    echo "  lambda      ${fn}: new code deployed"
  else
    awsl lambda create-function --function-name "$fn" --runtime nodejs22.x \
      --handler "backend/lambdas/${service}.handler" --zip-file fileb://build/lambda.zip \
      --role "arn:aws:iam::${ACCOUNT_ID}:role/${role}" \
      --environment "$env_vars" --memory-size 512 --timeout 15 >/dev/null
    echo "  lambda      ${fn}: created"
  fi
}

echo "=== [2/6] Three functions, each with its own secret, role and logs ==="
for entry in "${SERVICES[@]}"; do
  IFS='|' read -r fn service secret role <<< "$entry"
  deploy_function "$fn" "$service" "$secret" "$role"
done
echo "[2/6] done"

echo "=== [3/6] API Gateway: ${API_NAME} ==="
API=$(api_id)
declare -A INTEGRATION
for entry in "${SERVICES[@]}"; do
  IFS='|' read -r fn _ <<< "$entry"
  arn="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${fn}"
  id=$(awsl apigatewayv2 get-integrations --api-id "$API" \
    --query "Items[?IntegrationUri=='${arn}'].IntegrationId | [0]" --output text)
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    id=$(awsl apigatewayv2 create-integration --api-id "$API" --integration-type AWS_PROXY \
      --integration-uri "$arn" --payload-format-version 2.0 --query IntegrationId --output text)
  fi
  INTEGRATION[$fn]="$id"
  # Let this one API call the function (and nothing else)
  ok awsl lambda add-permission --function-name "$fn" --statement-id "apigw-${API_NAME}" \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API}/*/*"
done
for entry in "${ROUTES[@]}"; do
  IFS='|' read -r fn key <<< "$entry"
  put_route "$API" "$key" "${INTEGRATION[$fn]}" | sed "s|${INTEGRATION[$fn]}\$|${fn}|"
done
cat > "$TMP/throttle.json" <<JSON
{ "POST /api/v1/evaluations":       { "ThrottlingRateLimit": ${THROTTLE_RATE}, "ThrottlingBurstLimit": ${THROTTLE_BURST} },
  "POST /api/v1/evaluations/batch": { "ThrottlingRateLimit": ${THROTTLE_RATE}, "ThrottlingBurstLimit": ${THROTTLE_BURST} } }
JSON
awsl apigatewayv2 update-stage --api-id "$API" --stage-name '$default' --route-settings "file://$TMP/throttle.json" >/dev/null
echo "  throttle: ${THROTTLE_RATE} req/s, burst ${THROTTLE_BURST} on the evaluation routes"
echo "[3/6] done: API ${API}"

echo "=== [4/6] Self-test: each function on its own (Lambda -> Secrets Manager -> Neon) ==="
cat > "$TMP/event.json" <<'JSON'
{ "version": "2.0", "routeKey": "$default", "rawPath": "/api/v1/health", "rawQueryString": "",
  "headers": { "host": "self-test" },
  "requestContext": { "http": { "method": "GET", "path": "/api/v1/health", "sourceIp": "127.0.0.1" }, "stage": "$default" },
  "isBase64Encoded": false }
JSON
FAILED=0
for entry in "${SERVICES[@]}"; do
  IFS='|' read -r fn service _ <<< "$entry"
  awsl lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out --cli-read-timeout 120 \
    --payload "file://$TMP/event.json" "$TMP/out.json" >/dev/null
  result=$(node -e "const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log(r.statusCode, r.body)" "$TMP/out.json")
  printf '  %-13s %s\n' "$fn" "$result"
  [[ "$result" == 200*'"services":["'"$service"'"]'* ]] || FAILED=1
done

echo "=== [5/6] Self-test: through API Gateway (X-Served-By says which function answered) ==="
BASE="http://${API}.execute-api.localhost.floci.io:4566"
check() { # method path expected-status expected-function
  local out code served
  out=$(curl -s -m 120 -o /dev/null -D - -X "$1" "${BASE}$2" -H 'content-type: application/json' \
    $( [ "$1" = POST ] && echo "-d {}" ) | tr -d '\r')
  code=$(echo "$out" | awk 'NR==1{print $2}')
  served=$(echo "$out" | awk -F': ' 'tolower($1)=="x-served-by"{print $2}')
  printf '  %-6s %-30s %s  served by: %-6s' "$1" "$2" "$code" "${served:-?}"
  if [ "$code" = "$3" ] && [ "$served" = "$4" ]; then echo "  ok"; else echo "  EXPECTED $3 from $4"; FAILED=1; fi
}
check GET  /api/v1/health          200 eval
check GET  /api/v1/flags           401 flags
check GET  /api/v1/auth/me         401 flags
check POST /api/v1/evaluations     401 eval
check GET  /api/v1/rollouts/x      401 eval
check GET  /api/v1/audit           401 audit
check GET  /api/v1/alerts          401 audit
check GET  /api/v1/no-such-path    404 eval

if [ "$FAILED" != 0 ]; then
  echo
  echo "Something did not answer as expected (see above). Nothing was cleaned up."
  echo "Logs:  aws --endpoint-url ${ENDPOINT} logs tail /aws/lambda/<function>"
  exit 1
fi

echo "=== [6/6] Clean up the old Lab 7 single function (ffm-api) ==="
# Runs only AFTER every check above passed, so the old function is removed only once the new
# ones are proven to answer. Kept on purpose:
#   ffm/api-secrets      the shared session secret is copied from it (step 0)
#   /aws/lambda/ffm-api  its old logs are Lab 7 evidence
OLD_FN="ffm-api"
OLD_ROLE="ffm-api-role"
OLD_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${OLD_FN}"
# API Gateway connections to ffm-api (no route uses them any more after step 3)
for id in $(awsl apigatewayv2 get-integrations --api-id "$API"     --query "Items[?IntegrationUri=='${OLD_ARN}'].IntegrationId" --output text); do
  if [ -n "$(awsl apigatewayv2 get-routes --api-id "$API" --query "Items[?Target=='integrations/${id}'].RouteKey" --output text)" ]; then
    echo "  connection ${id} is still used by a route: kept"
  else
    awsl apigatewayv2 delete-integration --api-id "$API" --integration-id "$id"
    echo "  deleted the unused API Gateway connection to ${OLD_FN}"
  fi
done
if awsl lambda get-function --function-name "$OLD_FN" >/dev/null 2>&1; then
  awsl lambda delete-function --function-name "$OLD_FN" >/dev/null
  echo "  deleted Lambda ${OLD_FN}"
else
  echo "  (Lambda ${OLD_FN} already gone)"
fi
if awsl iam get-role --role-name "$OLD_ROLE" >/dev/null 2>&1; then
  for policy in $(awsl iam list-attached-role-policies --role-name "$OLD_ROLE" --query 'AttachedPolicies[].PolicyArn' --output text); do
    awsl iam detach-role-policy --role-name "$OLD_ROLE" --policy-arn "$policy"
    awsl iam delete-policy --policy-arn "$policy" 2>/dev/null || true
  done
  for policy in $(awsl iam list-role-policies --role-name "$OLD_ROLE" --query 'PolicyNames' --output text); do
    awsl iam delete-role-policy --role-name "$OLD_ROLE" --policy-name "$policy"
  done
  awsl iam delete-role --role-name "$OLD_ROLE"
  echo "  deleted IAM role ${OLD_ROLE} and its policy"
else
  echo "  (IAM role ${OLD_ROLE} already gone)"
fi
echo "[6/6] done (kept: secret ffm/api-secrets, log group /aws/lambda/ffm-api)"

echo
echo "All three functions are deployed and routed.  API Gateway: ${BASE}"
