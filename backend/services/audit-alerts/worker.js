// The outbox processor (S3): what ffm-alert-worker does with each SQS message.
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

module.exports = { processRecord, processSqsEvent };
