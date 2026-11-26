# Shared helpers for infra/floci/services/*.sh (same idea as infra/floci/lab8/_lib.sh).
# Floci accepts any non-empty keys; these are NOT real AWS keys.
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export ENDPOINT="http://localhost:4566"
export ACCOUNT_ID="000000000000"
export REGION="us-east-1"

# The repo root, so every script works from any folder
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export REPO

# The shared HTTP API and the S3 website (both from Lab 7, 16 Nov)
export API_NAME="ffm-http-api"
export WEB_ORIGIN="http://ffm-web.s3-website.localhost.floci.io:4566"

awsl() {
  MSYS_NO_PATHCONV=1 aws --endpoint-url "$ENDPOINT" "$@"
}

# Run a create command; "already exists" is fine, so every script can be run again.
ok() {
  local output
  if ! output=$("$@" 2>&1); then
    if echo "$output" | grep -qiE 'already exists|ResourceInUse|ResourceExists|EntityAlreadyExists|Duplicate|ResourceConflict'; then
      echo "  (already exists, skipping)"
    else
      echo "$output" >&2
      return 1
    fi
  fi
}

# The id of the shared HTTP API; created (with an auto-deploying $default stage) if missing.
api_id() {
  local id
  id=$(awsl apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    id=$(awsl apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --query ApiId --output text)
    awsl apigatewayv2 create-stage --api-id "$id" --stage-name '$default' --auto-deploy >/dev/null
  fi
  echo "$id"
}

# Point one route (e.g. "POST /api/v1/evaluations") at an integration: create it or move it.
put_route() {
  local api="$1" key="$2" integration="$3" existing
  existing=$(awsl apigatewayv2 get-routes --api-id "$api" --query "Items[?RouteKey=='${key}'].RouteId | [0]" --output text)
  if [ -z "$existing" ] || [ "$existing" = "None" ]; then
    awsl apigatewayv2 create-route --api-id "$api" --route-key "$key" --target "integrations/${integration}" >/dev/null
  else
    awsl apigatewayv2 update-route --api-id "$api" --route-id "$existing" --target "integrations/${integration}" >/dev/null
  fi
  echo "  ${key}  ->  ${integration}"
}
