# Shared helpers for infra/floci/lab8/*.sh (same idea as Lab 8's infra/services/_lib.sh).
# Each script sources this, so every script also runs on its own:  bash infra/floci/lab8/04-elbv2.sh
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export ENDPOINT="http://localhost:4566"
export ACCOUNT_ID="000000000000"

# The throwaway load-test database (tests/load/start-local-db.ps1). Never Neon.
export LOAD_DATABASE_URL="${LOAD_DATABASE_URL:-postgres://ffm_app:local-only@localhost:55432/ffm_load}"
export SECRET_NAME="ffm/load-test-config"

awsl() {
  MSYS_NO_PATHCONV=1 aws --endpoint-url "$ENDPOINT" "$@"
}

# Run a create command; "already exists" is fine, so every script can be run again.
ok() {
  local output
  if ! output=$("$@" 2>&1); then
    if echo "$output" | grep -qiE 'already exists|ResourceInUse|ResourceExists|EntityAlreadyExists|Duplicate'; then
      echo "  (already exists, skipping)"
    else
      echo "$output" >&2
      return 1
    fi
  fi
}
