#!/usr/bin/env bash
set -euo pipefail
# S1 only: versioned private snapshots + KMS encryption + EventBridge + optional SES notices.
# Run AFTER S2's Lambdas and S3's SNS setup. Never creates DB users or changes other Lambdas.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"
cd "$REPO"
BUCKET="ffm-flag-snapshots"
BUS="ffm-events"
RULE="prod-flag-change"
SES_FROM="${SES_FROM_ADDRESS:-security@ffm.local}"
FUNCTION="ffm-flags-fn"
ROLE="ffm-flags-role"
TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:ffm-ops-alerts"
BUS_ARN="arn:aws:events:${REGION}:${ACCOUNT_ID}:event-bus/${BUS}"
TMP="build/tmp-s1-$$"
mkdir -p "$TMP"
# Exact, script-owned relative directory; no user paths are used for cleanup.
cleanup() {
  local resolved
  resolved=$(realpath "$TMP")
  case "$resolved" in "$REPO"/build/tmp-s1-*) rm -rf -- "$resolved" ;; *) echo 'Refusing unexpected cleanup path' >&2 ;; esac
}
trap cleanup EXIT

command -v aws >/dev/null || { echo 'AWS CLI is required.'; exit 1; }
awsl sts get-caller-identity >/dev/null 2>&1 || { echo 'Start the local Floci container first.'; exit 1; }
awsl lambda get-function --function-name "$FUNCTION" >/dev/null || { echo 'Run S2 Lambda setup first.'; exit 1; }
awsl sns get-topic-attributes --topic-arn "$TOPIC_ARN" > "$TMP/topic.json" \
  || { echo 'Ebrahim must create ffm-ops-alerts with s3-audit.sh first.'; exit 1; }

echo '[1/7] Private, versioned snapshot bucket'
if ! awsl s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then awsl s3api create-bucket --bucket "$BUCKET" >/dev/null; fi
awsl s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
awsl s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled

echo '[2/7] Reuse or create the S1 KMS key'
KEY_ID=$(awsl kms describe-key --key-id alias/ffm-flags --query KeyMetadata.KeyId --output text 2>/dev/null || true)
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = 'None' ]; then
  KEY_ID=$(awsl kms create-key --description 'S1 AES-256 flag snapshot data keys' --key-usage ENCRYPT_DECRYPT \
    --key-spec SYMMETRIC_DEFAULT --query KeyMetadata.KeyId --output text)
  awsl kms create-alias --alias-name alias/ffm-flags --target-key-id "$KEY_ID"
fi
KEY_ARN="arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/${KEY_ID}"

echo '[3/7] Exact-resource permissions on the S1 role only'
cat > "$TMP/policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:ListBucketVersions"],
    "Resource": "arn:aws:s3:::${BUCKET}", "Condition": { "StringLike": { "s3:prefix": "teams/*/flags/*" } } },
  { "Effect": "Allow", "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"], "Resource": "arn:aws:s3:::${BUCKET}/teams/*/flags/*.json" },
  { "Effect": "Allow", "Action": ["kms:GenerateDataKey", "kms:Decrypt"], "Resource": "${KEY_ARN}" },
  { "Effect": "Allow", "Action": "events:PutEvents", "Resource": "${BUS_ARN}" }
] }
JSON
awsl iam put-role-policy --role-name "$ROLE" --policy-name ffm-s1-cloud --policy-document "file://$TMP/policy.json"

echo '[4/7] Configure the local SES sender identity and S1 send permission'
# The app chooses recipients from the team's Admin users at send time.
awsl ses verify-email-identity --email-address "$SES_FROM"
cat > "$TMP/ses-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "SendS1SecurityNotifications", "Effect": "Allow", "Action": "ses:SendEmail",
    "Resource": "arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${SES_FROM}" }
] }
JSON
awsl iam put-role-policy --role-name "$ROLE" --policy-name ffm-s1-ses --policy-document "file://$TMP/ses-policy.json"

echo '[5/7] Production events to the existing operations topic'
if ! awsl events describe-event-bus --name "$BUS" >/dev/null 2>&1; then awsl events create-event-bus --name "$BUS" >/dev/null; fi
cat > "$TMP/pattern.json" <<JSON
{ "source": ["ffm.flags"], "detail": { "env": ["prod"] } }
JSON
awsl events put-rule --name "$RULE" --event-bus-name "$BUS" --state ENABLED --event-pattern "file://$TMP/pattern.json" >/dev/null
awsl events put-targets --rule "$RULE" --event-bus-name "$BUS" --targets "Id=s1-ops,Arn=${TOPIC_ARN}" > "$TMP/targets.json"
node -e "if (require('./$TMP/targets.json').FailedEntryCount) process.exit(1)"
# Preserve the topic's existing alarm/worker permissions. Add only EventBridge's SNS grant,
# using AWS's documented service-principal policy shape for an SNS target.
node - "$TMP/topic.json" "$TMP/topic-policy.json" "$TOPIC_ARN" <<'NODE'
const fs = require('fs');
const [input, output, arn] = process.argv.slice(2);
const attributes = JSON.parse(fs.readFileSync(input, 'utf8')).Attributes || {};
const policy = attributes.Policy ? JSON.parse(attributes.Policy) : { Version: '2012-10-17', Statement: [] };
const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
policy.Statement = statements.filter(s => s && s.Sid !== 'FfmS1EventBridge');
policy.Statement.push({ Sid: 'FfmS1EventBridge', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sns:Publish', Resource: arn });
fs.writeFileSync(output, JSON.stringify(policy));
NODE
awsl sns set-topic-attributes --topic-arn "$TOPIC_ARN" --attribute-name Policy --attribute-value "file://$TMP/topic-policy.json"

echo '[6/7] Rebuild and update only the S1 Lambda; preserve its existing environment'
if [ "${SKIP_BUILD:-}" != '1' ]; then node infra/floci/build-lambda.js; fi
[ -f build/lambda.zip ] || { echo 'build/lambda.zip is missing.'; exit 1; }
awsl lambda update-function-code --function-name "$FUNCTION" --zip-file fileb://build/lambda.zip >/dev/null
awsl lambda wait function-updated --function-name "$FUNCTION"
awsl lambda get-function-configuration --function-name "$FUNCTION" --query Environment.Variables --output json > "$TMP/env.json"
node - "$TMP/env.json" "$BUCKET" "$KEY_ARN" "$BUS" "$SES_FROM" <<'NODE'
const fs = require('fs');
const [file, bucket, key, bus, sesFrom] = process.argv.slice(2);
const vars = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
Object.assign(vars, { SNAPSHOT_BUCKET: bucket, SNAPSHOT_KMS_KEY: key, EVENT_BUS_NAME: bus, S1_AWS_ENDPOINT: 'http://floci:4566', SES_FROM_ADDRESS: sesFrom });
fs.writeFileSync(file, JSON.stringify({ Variables: vars }));
NODE
awsl lambda update-function-configuration --function-name "$FUNCTION" --environment "file://$TMP/env.json" >/dev/null
awsl lambda wait function-updated --function-name "$FUNCTION"

echo '[7/7] Read-only configuration checks (no secrets printed)'
[ "$(awsl s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text)" = 'Enabled' ]
awsl events list-targets-by-rule --rule "$RULE" --event-bus-name "$BUS" --query 'Targets[].Arn'
awsl iam get-role-policy --role-name "$ROLE" --policy-name ffm-s1-cloud --query PolicyDocument
awsl iam get-role-policy --role-name "$ROLE" --policy-name ffm-s1-ses --query PolicyDocument
awsl ses get-identity-verification-attributes --identities "$SES_FROM" --query 'VerificationAttributes'
printf '\nS1 configured. Run: node tests/security/s1-floci-check.js\n'
printf 'Then test history and recovery through the gateway and save screenshots.\n'
