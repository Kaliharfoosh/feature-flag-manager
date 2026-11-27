#!/usr/bin/env bash
set -euo pipefail
# S3 (Ebrahim) on Floci: the alert outbox and the operations alarm.
#
#   Amazon SQS       ffm-alerts-queue (+ ffm-alerts-dlq after 3 tries): the outbox. After COMMIT the
#                    flags / eval / audit functions put { alertId } on it; ffm-alert-worker opens
#                    the GitHub issue. Answers the tutor's "outbox with no processor".
#   Amazon CloudWatch metrics FFM/FailedLogins, Forbidden, BotCheckFailures, ServerErrors (sent by
#                    shared/metrics.js) and alarm ffm-failed-logins: FailedLogins >= 5 in 5 min -> SNS.
#   Amazon SNS       ffm-ops-alerts: receives the alarm (and S1's prod-change events). The queue
#                    ffm-ops-inbox is subscribed so delivery can be shown without real email.
#   (plumbing, not counted) Lambda ffm-alert-worker, IAM role ffm-alert-worker-role,
#   Secrets Manager ffm/worker-db + ffm/github-token (the GitHub token: only the worker reads it).
#
# Run from Git Bash, Floci running, AFTER s2-lambdas.sh (it adds the queue to those functions):
#   bash infra/floci/services/s3-audit.sh
# Safe to run again: everything is created once and updated after that. Secrets are never printed.
#   SKIP_BUILD=1   reuse the last build/lambda.zip
#   ENV_FILE=...   read DATABASE_URL_APP, GITHUB_TOKEN, GITHUB_REPO from another file (default .env)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lib.sh"
cd "$REPO"

ENV_FILE="${ENV_FILE:-.env}"
TOPIC="ffm-ops-alerts"
INBOX="ffm-ops-inbox"
QUEUE="ffm-alerts-queue"
DLQ="ffm-alerts-dlq"
MAX_TRIES=3
VISIBILITY=60          # seconds; longer than the worker's timeout, as AWS requires
WORKER="ffm-alert-worker"
WORKER_ROLE="ffm-alert-worker-role"
WORKER_LOGS="/aws/lambda/${WORKER}"
DB_SECRET="ffm/worker-db"
GH_SECRET="ffm/github-token"
ALARM="ffm-failed-logins"
NAMESPACE="FFM"        # CloudWatch metrics from shared/metrics.js
PRODUCERS=(ffm-flags-fn ffm-eval-fn ffm-audit-fn)   # every function that can raise an alert

TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${TOPIC}"
QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE}"
DLQ_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${DLQ}"
INBOX_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${INBOX}"
WORKER_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${WORKER_ROLE}"

# Temporary files: build/ (ignored by git), relative paths for the Windows AWS CLI. Always deleted.
TMP="build/tmp-s3-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

queue_url() { awsl sqs get-queue-url --queue-name "$1" --query QueueUrl --output text; }
count() { awsl sqs get-queue-attributes --queue-url "$1" --attribute-names ApproximateNumberOfMessages \
  --query Attributes.ApproximateNumberOfMessages --output text; }

echo "=== [0/7] Checks ==="
command -v aws >/dev/null || { echo "AWS CLI not found. Install it first."; exit 1; }
awsl sts get-caller-identity >/dev/null 2>&1 \
  || { echo "Floci is not answering on ${ENDPOINT}. Start it:  docker compose -f infra/floci/docker-compose.yml up -d"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "${ENV_FILE} not found."; exit 1; }
node --env-file="$ENV_FILE" -e "process.exit(process.env.DATABASE_URL_APP ? 0 : 1)" \
  || { echo "DATABASE_URL_APP (the ffm_app login) is missing in ${ENV_FILE}."; exit 1; }
if ! node --env-file="$ENV_FILE" -e "process.exit(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO ? 0 : 1)"; then
  echo "  WARNING: GITHUB_TOKEN / GITHUB_REPO missing in ${ENV_FILE}: alerts will fail and end in ${DLQ}."
fi
echo "[0/7] done"

echo "=== [1/7] Build the Lambda code (build/lambda.zip, the same zip as the other functions) ==="
if [ "${SKIP_BUILD:-}" = "1" ] && [ -f build/lambda.zip ]; then
  echo "  (SKIP_BUILD=1: using the existing build/lambda.zip)"
else
  node infra/floci/build-lambda.js
fi
echo "[1/7] done"

echo "=== [2/7] SNS: ${TOPIC} (+ ${INBOX} subscribed, to show delivery) ==="
awsl sns create-topic --name "$TOPIC" >/dev/null
awsl sqs create-queue --queue-name "$INBOX" >/dev/null
if [ -z "$(awsl sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
      --query "Subscriptions[?Endpoint=='${INBOX_ARN}'].SubscriptionArn" --output text)" ]; then
  awsl sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$INBOX_ARN" >/dev/null
fi
echo "  topic       ${TOPIC_ARN}"
echo "  subscriber  ${INBOX} (SQS)"
echo "[2/7] done"

echo "=== [3/7] SQS: ${QUEUE} -> ${DLQ} after ${MAX_TRIES} tries ==="
awsl sqs create-queue --queue-name "$DLQ" --attributes MessageRetentionPeriod=1209600 >/dev/null
cat > "$TMP/queue-attributes.json" <<JSON
{ "VisibilityTimeout": "${VISIBILITY}",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"${MAX_TRIES}\"}" }
JSON
awsl sqs create-queue --queue-name "$QUEUE" --attributes "file://$TMP/queue-attributes.json" >/dev/null 2>&1 || true
QUEUE_URL=$(queue_url "$QUEUE")
DLQ_URL=$(queue_url "$DLQ")
awsl sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "file://$TMP/queue-attributes.json"
# Queue policy (a second lock): only the alert-raising functions may send, only the worker may read.
node -e "
  const [acc, region, queueArn, worker, ...producers] = process.argv.slice(1);
  const role = (name) => 'arn:aws:iam::' + acc + ':role/' + name;
  const policy = { Version: '2012-10-17', Statement: [
    { Sid: 'OnlyAlertProducersSend', Effect: 'Allow', Principal: { AWS: producers.map(role) },
      Action: 'sqs:SendMessage', Resource: queueArn },
    { Sid: 'OnlyTheWorkerReads', Effect: 'Allow', Principal: { AWS: role(worker) },
      Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'],
      Resource: queueArn } ] };
  require('fs').writeFileSync('$TMP/queue-policy.json', JSON.stringify({ Policy: JSON.stringify(policy) }));
" "$ACCOUNT_ID" "$REGION" "$QUEUE_ARN" "$WORKER_ROLE" ffm-flags-role ffm-eval-role ffm-audit-role
awsl sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "file://$TMP/queue-policy.json"
echo "  queue       ${QUEUE_URL} (visibility ${VISIBILITY} s, DLQ after ${MAX_TRIES})"
echo "  DLQ         ${DLQ_URL} (kept 14 days)"
echo "[3/7] done"

echo "=== [4/7] Secrets: ${DB_SECRET}, ${GH_SECRET} (only ${WORKER_ROLE} may read them) ==="
put_secret() { # name description json-file
  if awsl secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1; then
    awsl secretsmanager put-secret-value --secret-id "$1" --secret-string "file://$3" >/dev/null
  else
    awsl secretsmanager create-secret --name "$1" --description "$2" --secret-string "file://$3" >/dev/null
  fi
  rm -f "$3"
  cat > "$TMP/secret-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [ { "Sid": "OnlyTheWorker", "Effect": "Allow",
  "Principal": { "AWS": "${WORKER_ROLE_ARN}" }, "Action": "secretsmanager:GetSecretValue", "Resource": "*" } ] }
JSON
  awsl secretsmanager put-resource-policy --secret-id "$1" --resource-policy "file://$TMP/secret-policy.json" >/dev/null 2>&1 || true
  echo "  secret      $1 (value never printed)"
}
node --env-file="$ENV_FILE" -e "
  const fs = require('fs');
  fs.writeFileSync('$TMP/db.json', JSON.stringify({ DATABASE_URL: process.env.DATABASE_URL_APP }));
  const gh = {};
  if (process.env.GITHUB_TOKEN) gh.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (process.env.GITHUB_REPO) gh.GITHUB_REPO = process.env.GITHUB_REPO;
  fs.writeFileSync('$TMP/gh.json', JSON.stringify(gh));
"
put_secret "$DB_SECRET" "${WORKER}: the ffm_app database login" "$TMP/db.json"
put_secret "$GH_SECRET" "${WORKER}: fine-grained GitHub token (Issues: write) + repo" "$TMP/gh.json"
echo "[4/7] done"

echo "=== [5/7] Lambda ${WORKER} (triggered by ${QUEUE}, batch size 1) ==="
ok awsl logs create-log-group --log-group-name "$WORKER_LOGS"
awsl logs put-retention-policy --log-group-name "$WORKER_LOGS" --retention-in-days 7
ok awsl iam create-role --role-name "$WORKER_ROLE" \
  --assume-role-policy-document file://infra/iam/trust-policy.json \
  --description "${WORKER}: read its 2 secrets, consume ${QUEUE}, write its own logs"
cat > "$TMP/worker-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "ReadOnlyItsTwoSecrets", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
    "Resource": [ "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${DB_SECRET}-*",
                  "arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${GH_SECRET}-*" ] },
  { "Sid": "ConsumeOnlyTheAlertQueue", "Effect": "Allow",
    "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"],
    "Resource": "${QUEUE_ARN}" },
  { "Sid": "WriteOnlyItsOwnLogs", "Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
    "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${WORKER_LOGS}:*" } ] }
JSON
awsl iam put-role-policy --role-name "$WORKER_ROLE" --policy-name "${WORKER}-access" \
  --policy-document "file://$TMP/worker-policy.json"
echo "  role        ${WORKER_ROLE}"
WORKER_ENV="Variables={SECRET_ID=${DB_SECRET},GITHUB_SECRET_ID=${GH_SECRET}}"
if awsl lambda get-function --function-name "$WORKER" >/dev/null 2>&1; then
  awsl lambda update-function-code --function-name "$WORKER" --zip-file fileb://build/lambda.zip >/dev/null
  awsl lambda wait function-updated --function-name "$WORKER" 2>/dev/null || true
  awsl lambda update-function-configuration --function-name "$WORKER" \
    --handler backend/lambdas/alert-worker.handler --role "$WORKER_ROLE_ARN" \
    --environment "$WORKER_ENV" --memory-size 256 --timeout 20 >/dev/null
  echo "  lambda      ${WORKER}: new code deployed"
else
  awsl lambda create-function --function-name "$WORKER" --runtime nodejs22.x \
    --handler backend/lambdas/alert-worker.handler --zip-file fileb://build/lambda.zip \
    --role "$WORKER_ROLE_ARN" --environment "$WORKER_ENV" --memory-size 256 --timeout 20 >/dev/null
  echo "  lambda      ${WORKER}: created"
fi
awsl lambda wait function-active-v2 --function-name "$WORKER" 2>/dev/null || true
if [ -z "$(awsl lambda list-event-source-mappings --function-name "$WORKER" \
      --query "EventSourceMappings[?EventSourceArn=='${QUEUE_ARN}'].UUID" --output text)" ]; then
  awsl lambda create-event-source-mapping --function-name "$WORKER" --event-source-arn "$QUEUE_ARN" \
    --batch-size 1 >/dev/null
fi
echo "  trigger     ${QUEUE} -> ${WORKER}"
echo "[5/7] done"

echo "=== [6/7] Producers: the three functions may queue alerts and send metrics ==="
# A separate inline policy and one extra setting, so s2-lambdas.sh re-runs keep them
# (it rewrites only its own "<fn>-access" policy, and it keeps ALERTS_QUEUE_URL and METRICS_NAMESPACE).
cat > "$TMP/send-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [ { "Sid": "SendOnlyToTheAlertQueue", "Effect": "Allow",
  "Action": "sqs:SendMessage", "Resource": "${QUEUE_ARN}" } ] }
JSON
# PutMetricData has no resource ARN in AWS, so it is limited by namespace instead: FFM only.
cat > "$TMP/metrics-policy.json" <<JSON
{ "Version": "2012-10-17", "Statement": [ { "Sid": "PutMetricsOnlyInFFM", "Effect": "Allow",
  "Action": "cloudwatch:PutMetricData", "Resource": "*",
  "Condition": { "StringEquals": { "cloudwatch:namespace": "${NAMESPACE}" } } } ] }
JSON
MISSING=0
for fn in "${PRODUCERS[@]}"; do
  if ! awsl lambda get-function --function-name "$fn" >/dev/null 2>&1; then
    echo "  ${fn}: not deployed yet (run s2-lambdas.sh, then this script again)"; MISSING=1; continue
  fi
  role=$(awsl lambda get-function-configuration --function-name "$fn" --query Role --output text)
  awsl iam put-role-policy --role-name "${role##*/}" --policy-name ffm-alerts-send \
    --policy-document "file://$TMP/send-policy.json"
  awsl iam put-role-policy --role-name "${role##*/}" --policy-name ffm-metrics-put     --policy-document "file://$TMP/metrics-policy.json"
  awsl lambda get-function-configuration --function-name "$fn" --query Environment.Variables --output json \
    > "$TMP/env.json"
  node -e "
    const fs = require('fs');
    let vars = {};
    try { vars = JSON.parse(fs.readFileSync('$TMP/env.json', 'utf8')) || {}; } catch {}
    vars.ALERTS_QUEUE_URL = process.argv[1];
    vars.METRICS_NAMESPACE = process.argv[2];
    fs.writeFileSync('$TMP/env.json', JSON.stringify({ Variables: vars }));
  " "$QUEUE_URL" "$NAMESPACE"
  awsl lambda update-function-configuration --function-name "$fn" --environment "file://$TMP/env.json" >/dev/null
  echo "  ${fn}: ALERTS_QUEUE_URL + METRICS_NAMESPACE set, role ${role##*/} may send to both"
done
echo "[6/7] done"

echo "=== [7/7] CloudWatch alarm ${ALARM}: FFM/FailedLogins >= 5 in 5 minutes -> ${TOPIC} ==="
awsl cloudwatch put-metric-alarm --alarm-name "$ALARM" \
  --alarm-description "5 or more failed logins in 5 minutes (S3 monitoring)" \
  --namespace FFM --metric-name FailedLogins --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC_ARN" --ok-actions "$TOPIC_ARN"
echo "  alarm       ${ALARM} -> ${TOPIC}"
echo "[7/7] done"

echo "=== Self-test ==="
FAILED=0
# 1. The worker on its own: Lambda -> both secrets -> database. A random alert id has nothing to
#    claim, so it answers without calling GitHub.
RANDOM_ID=$(node -e "console.log(require('crypto').randomUUID())")
cat > "$TMP/event.json" <<JSON
{ "Records": [ { "messageId": "self-test", "body": "{\"alertId\":\"${RANDOM_ID}\"}",
  "attributes": { "ApproximateReceiveCount": "1" }, "eventSource": "aws:sqs", "eventSourceARN": "${QUEUE_ARN}" } ] }
JSON
awsl lambda invoke --function-name "$WORKER" --cli-binary-format raw-in-base64-out --cli-read-timeout 120 \
  --payload "file://$TMP/event.json" "$TMP/out.json" > "$TMP/invoke.json"
if grep -q FunctionError "$TMP/invoke.json"; then
  echo "  worker invoke        FAILED: $(head -c 300 "$TMP/out.json")"; FAILED=1
else
  echo "  worker invoke        ok: $(cat "$TMP/out.json")"
fi
# 2. Through the queue: the trigger runs the worker and the message is deleted, not sent to the DLQ.
DLQ_BEFORE=$(count "$DLQ_URL")
awsl sqs send-message --queue-url "$QUEUE_URL" --message-body "{\"alertId\":\"${RANDOM_ID}\"}" >/dev/null
for _ in $(seq 1 20); do
  [ "$(count "$QUEUE_URL")" = 0 ] && \
  [ "$(awsl sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names ApproximateNumberOfMessagesNotVisible \
        --query Attributes.ApproximateNumberOfMessagesNotVisible --output text)" = 0 ] && break
  sleep 2
done
if [ "$(count "$QUEUE_URL")" = 0 ] && [ "$(count "$DLQ_URL")" = "$DLQ_BEFORE" ]; then
  echo "  queue -> worker      ok: message processed and deleted, DLQ unchanged (${DLQ_BEFORE})"
else
  echo "  queue -> worker      FAILED: queue $(count "$QUEUE_URL"), DLQ $(count "$DLQ_URL") (was ${DLQ_BEFORE})"; FAILED=1
fi
# 3. SNS delivers to its subscriber.
INBOX_URL=$(queue_url "$INBOX")
awsl sqs purge-queue --queue-url "$INBOX_URL" 2>/dev/null || true
awsl sns publish --topic-arn "$TOPIC_ARN" --subject "s3-audit self-test" --message "self-test" >/dev/null
sleep 2
if [ "$(count "$INBOX_URL")" -ge 1 ]; then
  echo "  SNS -> ${INBOX}  ok"
else
  echo "  SNS -> ${INBOX}  FAILED"; FAILED=1
fi
awsl sqs purge-queue --queue-url "$INBOX_URL" 2>/dev/null || true
# 4. The alarm is wired to the topic.
if [ "$(awsl cloudwatch describe-alarms --alarm-names "$ALARM" --query 'MetricAlarms[0].AlarmActions[0]' --output text)" = "$TOPIC_ARN" ]; then
  echo "  alarm -> SNS         ok"
else
  echo "  alarm -> SNS         FAILED"; FAILED=1
fi

if [ "$FAILED" != 0 ]; then
  echo; echo "Something did not work (see above).  Logs:  aws --endpoint-url ${ENDPOINT} logs tail ${WORKER_LOGS}"
  exit 1
fi
echo
echo "S3 outbox ready. Queue ${QUEUE}, DLQ ${DLQ}, topic ${TOPIC}, alarm ${ALARM}."
[ "$MISSING" = 0 ] || echo "Some producer functions were missing: run s2-lambdas.sh, then this script again."
