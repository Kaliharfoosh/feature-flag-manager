// Read-only local Floci inventory. Never reads secret values, Lambda environment variables or .env.
// Run: node infra/floci/services/capture-evidence.js
const { execFileSync } = require('node:child_process');
const { writeFileSync, renameSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', '..', '..');
const endpoint = 'http://localhost:4566';
const awsEnv = { ...process.env, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_DEFAULT_REGION: 'us-east-1' };

function aws(service, operation, args = []) {
  const output = execFileSync('aws', ['--endpoint-url', endpoint, service, operation, ...args, '--output', 'json'], {
    cwd: root, env: awsEnv, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(output);
}
function required(value, label) {
  if (!value) throw new Error(`Missing local Floci resource: ${label}`);
  return value;
}
async function httpCheck(url, expectedStatus, expectedService) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const servedBy = response.headers.get('x-served-by');
  if (response.status !== expectedStatus || (expectedService && servedBy !== expectedService)) {
    throw new Error(`Unexpected response for ${new URL(url).pathname}: ${response.status} / ${servedBy}`);
  }
  return { path: new URL(url).pathname, status: response.status, ...(expectedService && { servedBy }) };
}

(async () => {
  const identity = aws('sts', 'get-caller-identity');
  if (identity.Account !== '000000000000') throw new Error('Expected the local Floci account.');
  const functions = aws('lambda', 'list-functions').Functions.map(item => item.FunctionName);
  const functionNames = ['ffm-flags-fn', 'ffm-eval-fn', 'ffm-audit-fn', 'ffm-alert-worker'];
  functionNames.forEach(name => required(functions.includes(name), name));

  const api = required(aws('apigatewayv2', 'get-apis').Items.find(item => item.Name === 'ffm-http-api'), 'ffm-http-api');
  const routes = aws('apigatewayv2', 'get-routes', ['--api-id', api.ApiId]).Items.map(item => item.RouteKey).sort();
  ['GET /api/v1/health', 'ANY /api/v1/flags', 'POST /api/v1/evaluations', 'ANY /api/v1/audit'].forEach(
    route => required(routes.includes(route), route),
  );
  const secrets = aws('secretsmanager', 'list-secrets').SecretList.map(item => item.Name);
  const secretNames = ['ffm/flags-db', 'ffm/eval-db', 'ffm/audit-db', 'ffm/worker-db', 'ffm/github-token'];
  secretNames.forEach(name => required(secrets.includes(name), name));

  const versioning = aws('s3api', 'get-bucket-versioning', ['--bucket', 'ffm-flag-snapshots']);
  required(versioning.Status === 'Enabled', 'versioned ffm-flag-snapshots bucket');
  const kms = aws('kms', 'describe-key', ['--key-id', 'alias/ffm-flags']);
  required(kms.KeyMetadata?.KeyState === 'Enabled', 'alias/ffm-flags');
  const bus = aws('events', 'describe-event-bus', ['--name', 'ffm-events']);
  required(bus.Name === 'ffm-events', 'ffm-events');
  const eventRules = aws('events', 'list-rules', ['--event-bus-name', 'ffm-events']).Rules.map(item => item.Name);
  required(eventRules.includes('prod-flag-change'), 'prod-flag-change rule');
  const sesIdentities = aws('ses', 'list-identities', ['--identity-type', 'EmailAddress']).Identities;
  required(sesIdentities.length > 0, 'SES sender identity');
  const sesVerification = aws('ses', 'get-identity-verification-attributes', ['--identities', ...sesIdentities]).VerificationAttributes;
  const verifiedSesSenders = sesIdentities.filter(name => sesVerification[name]?.VerificationStatus === 'Success');
  required(verifiedSesSenders.length > 0, 'verified SES sender');

  const queueNames = ['ffm-alerts-queue', 'ffm-alerts-dlq', 'ffm-ops-inbox'];
  queueNames.forEach(name => required(aws('sqs', 'get-queue-url', ['--queue-name', name]).QueueUrl, name));
  const alarm = required(aws('cloudwatch', 'describe-alarms', ['--alarm-names', 'ffm-failed-logins']).MetricAlarms[0], 'ffm-failed-logins alarm');
  const topics = aws('sns', 'list-topics').Topics.map(item => item.TopicArn.split(':').at(-1));
  required(topics.includes('ffm-ops-alerts'), 'ffm-ops-alerts topic');
  const schedules = aws('scheduler', 'list-schedules').Schedules.map(item => item.Name);
  ['ffm-alert-sweeper', 'ffm-daily-audit-summary'].forEach(name => required(schedules.includes(name), name));

  const apiUrl = `http://${api.ApiId}.execute-api.localhost.floci.io:4566`;
  const webUrl = 'http://ffm-web.s3-website.localhost.floci.io:4566';
  const checks = await Promise.all([
    httpCheck(`${apiUrl}/api/v1/health`, 200, 'eval'),
    httpCheck(`${apiUrl}/api/v1/flags`, 401, 'flags'),
    httpCheck(`${apiUrl}/api/v1/audit`, 401, 'audit'),
    httpCheck(webUrl, 200),
  ]);
  const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const evidence = {
    kind: 'Local Floci resource and route verification',
    checkedAt: new Date().toISOString(), revision, endpoint, apiUrl, webUrl,
    s1: { bucket: 'ffm-flag-snapshots', versioning: versioning.Status, kmsAlias: 'alias/ffm-flags', kmsState: kms.KeyMetadata.KeyState, eventBus: bus.Name, eventRules: ['prod-flag-change'], sesVerifiedSenders: verifiedSesSenders },
    s2: { functions: functionNames.slice(0, 3), apiGateway: api.Name, routeCount: routes.length, secretNames: secretNames.slice(0, 3), websiteBucket: 'ffm-web' },
    s3: { worker: 'ffm-alert-worker', queues: queueNames, topic: 'ffm-ops-alerts', alarm: alarm.AlarmName, alarmState: alarm.StateValue, schedules: ['ffm-alert-sweeper', 'ffm-daily-audit-summary'], secretNames: secretNames.slice(3) },
    checks,
    limitations: ['Floci records IAM policies but does not prove real AWS IAM enforcement.', 'Local login uses Cloudflare Turnstile test keys.'],
  };
  const dir = join(root, 'evidence', 'test-results');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'floci-services.json');
  const temp = target + '.tmp';
  writeFileSync(temp, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, target);
  console.log(`Verified ${functionNames.length} Lambdas, ${routes.length} gateway routes, S1/S2/S3 resources and ${checks.length} HTTP checks.`);
  console.log('Evidence saved to evidence/test-results/floci-services.json (no secret values).');
})().catch(error => { console.error('Floci evidence check failed:', error.message); process.exitCode = 1; });
