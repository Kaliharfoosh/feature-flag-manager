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

module.exports = { enabled, enqueue };
