// The alert outbox on AWS (S3): Amazon SQS queue ffm-alerts-queue, processed by ffm-alert-worker.
//
// Switched on by ALERTS_QUEUE_URL. On Floci every function that can raise an alert (flags, eval,
// audit) has it set, so after COMMIT the request only puts { alertId } on the queue and answers;
// the worker opens the GitHub issue (backend/lambdas/alert-worker.js). After 3 failed tries SQS
// moves the message to ffm-alerts-dlq.
// On Vercel ALERTS_QUEUE_URL is not set and github.deliverPending() sends the issue inline,
// exactly as before (nothing runs in the background there).
//
// The message holds only the alert id: no audit details, no token. The worker reads the rest
// from the database, so a message read from the queue reveals nothing.
let client;

function sqs() {
  if (!client) {
    // Loaded only when the queue is used, so Vercel never loads the SQS SDK.
    const { SQSClient } = require('@aws-sdk/client-sqs');
    // No keys: the function's IAM role allows sqs:SendMessage. Short timeouts and one retry: if
    // the queue is down, the request falls back to inline delivery in about 2 s, not 8.
    client = new SQSClient({
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 },
    });
  }
  return client;
}

function enabled(env = process.env) {
  return Boolean(env.ALERTS_QUEUE_URL);
}

async function enqueue(alertId, { env = process.env, send = (command) => sqs().send(command) } = {}) {
  const { SendMessageCommand } = require('@aws-sdk/client-sqs');
  await send(new SendMessageCommand({
    QueueUrl: env.ALERTS_QUEUE_URL,
    MessageBody: JSON.stringify({ alertId }),
  }));
}

// ---- Dead letters (ffm-alerts-dlq): messages the worker failed 3 times ----------------------
// Only ffm-audit-fn has ALERTS_DLQ_URL and the IAM rights to read the DLQ (s3-audit.sh).
//
// The DLQ is shared by every team, but an Admin may only see and replay their own team's alerts.
// SQS cannot filter, so scan() reads the messages in batches of 10 (hidden from other readers for
// 30 s), asks the database which alert ids belong to the team, and then:
//   count mode   releases every message again at once (visibility 0)
//   replay mode  puts the team's alert ids back on the main queue and deletes them from the DLQ;
//                other teams' messages are released untouched
// At most MAX_SCAN messages are read per call; `complete: false` says there may be more.
const MAX_SCAN = 100;
const HIDE_SECONDS = 30;

function deadLettersEnabled(env = process.env) {
  return Boolean(env.ALERTS_DLQ_URL && env.ALERTS_QUEUE_URL);
}

function alertIdIn(message) {
  try {
    const { alertId } = JSON.parse(message.Body);
    return typeof alertId === 'string' ? alertId : null;
  } catch {
    return null;
  }
}

// ownedBy(ids) resolves the Set of those alert ids that belong to the Admin's team.
async function scanDeadLetters({ replay = false, ownedBy, env = process.env, send = (command) => sqs().send(command) }) {
  const sdk = require('@aws-sdk/client-sqs');
  const dlq = env.ALERTS_DLQ_URL;
  const release = [];
  let scanned = 0;
  let deadLetters = 0;
  let replayed = 0;
  let complete = true;
  try {
    while (true) {
      if (scanned >= MAX_SCAN) { complete = false; break; }
      const { Messages: batch = [] } = await send(new sdk.ReceiveMessageCommand({
        QueueUrl: dlq, MaxNumberOfMessages: 10, VisibilityTimeout: HIDE_SECONDS, WaitTimeSeconds: 0,
      }));
      if (batch.length === 0) break;
      scanned += batch.length;
      const ids = batch.map(alertIdIn);
      const mine = await ownedBy(ids.filter(Boolean));
      for (const [i, message] of batch.entries()) {
        if (!ids[i] || !mine.has(ids[i])) { release.push(message.ReceiptHandle); continue; }
        deadLetters += 1;
        if (!replay) { release.push(message.ReceiptHandle); continue; }
        // Send first, then delete: if the delete fails, the alert is queued twice, which the
        // worker's claim makes harmless. The other order could lose it.
        await send(new sdk.SendMessageCommand({ QueueUrl: env.ALERTS_QUEUE_URL, MessageBody: JSON.stringify({ alertId: ids[i] }) }));
        await send(new sdk.DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: message.ReceiptHandle }));
        replayed += 1;
      }
    }
  } finally {
    // Give every message we did not take back to the DLQ straight away.
    for (let i = 0; i < release.length; i += 10) {
      await send(new sdk.ChangeMessageVisibilityBatchCommand({
        QueueUrl: dlq,
        Entries: release.slice(i, i + 10).map((handle, n) => ({ Id: String(n), ReceiptHandle: handle, VisibilityTimeout: 0 })),
      })).catch(() => {}); // they become visible again after HIDE_SECONDS anyway
    }
  }
  return { deadLetters, replayed, scanned, complete };
}

module.exports = { enabled, enqueue, deadLettersEnabled, scanDeadLetters, MAX_SCAN };
