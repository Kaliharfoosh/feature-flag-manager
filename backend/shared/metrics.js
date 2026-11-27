// CloudWatch metrics for security events (S3). Called by shared/audit.js, so every service's
// failed logins, 403s, failed bot checks and server errors are counted the same way.
//
// Switched on by METRICS_NAMESPACE (Floci: "FFM"). On Vercel it is not set and this does nothing;
// the monitoring page there reads the same counts from audit_events.
// The alarm ffm-failed-logins (infra/floci/services/s3-audit.sh) watches FFM/FailedLogins.
//
// Best effort, like the audit log's security events: a CloudWatch problem is logged and never
// changes the answer the client gets. Each call waits at most about 1 s.
const METRIC_FOR = {
  'login.failed': 'FailedLogins',
  'access.denied': 'Forbidden',
  'bot_check.failed': 'BotCheckFailures',
  'server.error': 'ServerErrors',
};

let client;

function cloudwatch() {
  if (!client) {
    // Loaded only when metrics are on, so Vercel never loads the CloudWatch SDK.
    const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
    client = new CloudWatchClient({ // no keys: the function's role allows PutMetricData in FFM only
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 500, requestTimeout: 1000 },
    });
  }
  return client;
}

// Adds 1 to the metric for this audit action. Resolves the metric name, or null when the action
// has no metric or metrics are off.
async function count(action, { env = process.env, send = (command) => cloudwatch().send(command), log = console } = {}) {
  const name = METRIC_FOR[action];
  if (!name || !env.METRICS_NAMESPACE) return null;
  const { PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
  try {
    await send(new PutMetricDataCommand({
      Namespace: env.METRICS_NAMESPACE,
      MetricData: [{ MetricName: name, Value: 1, Unit: 'Count' }],
    }));
  } catch (err) {
    log.warn({ metric: name, reason: err.message }, 'metrics: not sent');
  }
  return name;
}

module.exports = { count, METRIC_FOR };
