// The outbox processor (S3): what ffm-alert-worker does with each SQS message, plus the two
// scheduled jobs at the end of this file (sweep, daily-summary).
// Lambda wrapper: backend/lambdas/alert-worker.js. Producer: queue.js.
//
// SQS delivers at least once, so the same alert id can arrive twice. That is safe: deliver()
// claims the alert row first (open/failed -> sending), so a second copy finds nothing to claim
// and is dropped without opening a second issue.
//
// A failed delivery THROWS. SQS then keeps the message, offers it again after the visibility
// timeout, and after 3 tries moves it to ffm-alerts-dlq. The alert row says "failed" with the
// reason, and an Admin can still retry it from the monitoring page.
const github = require('./github');
const queue = require('./queue');
const query = require('./query');
const logger = require('../../shared/logger');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function alertIdOf(record) {
  let alertId;
  try {
    ({ alertId } = JSON.parse(record.body));
  } catch {
    // handled below
  }
  if (typeof alertId !== 'string' || !UUID.test(alertId)) {
    throw new Error('Message is not { "alertId": "<uuid>" }.');
  }
  return alertId;
}

// Resolves 'sent' or 'skipped' (nothing to claim: already sent, or being sent right now).
async function processRecord(record, { deliver = github.deliver } = {}) {
  const alertId = alertIdOf(record);
  const row = await deliver(alertId);
  return { alertId, status: row ? row.status : 'skipped' };
}

// The worker runs with batch size 1, so one failure fails the whole (single-message) batch and
// only that message is retried. Throws when any message failed.
async function processSqsEvent(event, { deliver, log = logger } = {}) {
  const records = (event && event.Records) || [];
  const failed = [];
  for (const record of records) {
    const receiveCount = Number(record.attributes?.ApproximateReceiveCount) || 1;
    try {
      const result = await processRecord(record, { deliver });
      log.info({ messageId: record.messageId, receiveCount, ...result }, 'alert-worker: done');
    } catch (err) {
      log.warn({ messageId: record.messageId, receiveCount, reason: err.message }, 'alert-worker: delivery failed');
      failed.push(record.messageId);
    }
  }
  if (failed.length) {
    throw new Error(`${failed.length} of ${records.length} alert(s) not delivered; SQS will retry (then the DLQ).`);
  }
  return { processed: records.length };
}

// ---- Scheduled jobs (EventBridge Scheduler -> this same Lambda) -------------------------------
// The schedules send { "task": "sweep" } or { "task": "daily-summary" } (s3-audit.sh).

// Puts alerts that never reached the worker back on the queue. Re-queuing one that is already
// waiting is harmless: the claim in deliver() lets only one copy send.
async function sweep({ stuck = github.stuckAlertIds, enqueue = (id) => queue.enqueue(id), log = logger } = {}) {
  const ids = await stuck();
  for (const id of ids) await enqueue(id);
  log.info({ task: 'sweep', requeued: ids.length }, 'alert-worker: sweep');
  return { task: 'sweep', requeued: ids.length };
}

const LINES = [
  ['Security', [
    ['failedLogins', 'Failed logins'],
    ['botCheckFailures', 'Bot checks failed'],
    ['forbidden', 'Refused (403)'],
    ['serverErrors', 'Server errors (5xx)'],
    ['rateLimited', 'Rate limited (429)'],
  ]],
  ['Changes', [
    ['changes', 'All changes'],
    ['prodChanges', 'Production changes'],
  ]],
  ['Alerts', [
    ['alertsRaised', 'Raised'],
    ['alertsSent', 'GitHub issue opened'],
    ['alertsFailedNow', 'Failed, waiting for a retry (all time)'],
  ]],
];

function summaryText(s, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const width = Math.max(...LINES.flatMap(([, rows]) => rows.map(([, label]) => label.length)));
  const body = LINES.map(([section, rows]) => [
    section,
    ...rows.map(([key, label]) => `  ${label.padEnd(width)}  ${String(s[key]).padStart(5)}`),
  ].join('\n')).join('\n\n');
  return {
    subject: `FFM daily audit summary ${day}`,
    message: `Feature Flag Manager, all teams, last ${s.hours} hours (to ${now.toISOString().slice(0, 16)}Z)\n\n${body}\n\n`
      + 'Details per team: the Monitoring page and the audit log.\n',
  };
}

let snsClient;
function publishToSns(input) {
  const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
  snsClient = snsClient || new SNSClient({}); // the worker's role may publish to ffm-ops-alerts only
  return snsClient.send(new PublishCommand(input));
}

async function dailySummary({ summary = query.platformSummary, publish = publishToSns, env = process.env, now = new Date(), log = logger } = {}) {
  if (!env.OPS_TOPIC_ARN) throw new Error('OPS_TOPIC_ARN is not set.');
  const counts = await summary(24);
  const { subject, message } = summaryText(counts, now);
  await publish({ TopicArn: env.OPS_TOPIC_ARN, Subject: subject, Message: message });
  log.info({ task: 'daily-summary', ...counts }, 'alert-worker: daily summary published');
  return { task: 'daily-summary', ...counts };
}

// The Lambda entry point: SQS messages, or one of the scheduled jobs.
async function handle(event, deps = {}) {
  if (event && Array.isArray(event.Records)) return processSqsEvent(event, deps);
  if (event && event.task === 'sweep') return sweep(deps);
  if (event && event.task === 'daily-summary') return dailySummary(deps);
  throw new Error('Unknown event: expected SQS records or { "task": "sweep" | "daily-summary" }.');
}

module.exports = { processRecord, processSqsEvent, sweep, dailySummary, summaryText, handle };
