// ffm-alert-worker (S3): the outbox processor. Triggered by SQS (ffm-alerts-queue, batch size 1)
// and by two EventBridge Scheduler schedules: the sweeper (every 10 min) and the daily summary.
// Lambda handler = backend/lambdas/alert-worker.handler. Not behind API Gateway: no HTTP route.
//
// It reads TWO secrets on the first message, and its IAM role may read only these two:
//   SECRET_ID         ffm/worker-db     { "DATABASE_URL": "..." }   (the limited ffm_app login)
//   GITHUB_SECRET_ID  ffm/github-token  { "GITHUB_TOKEN": "...", "GITHUB_REPO": "owner/repo" }
// No other function can read the GitHub token on Floci. Values are never logged.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const SECRETS = [
  ['SECRET_ID', ['DATABASE_URL']],
  ['GITHUB_SECRET_ID', ['GITHUB_TOKEN', 'GITHUB_REPO']],
];

async function loadSecrets(env = process.env, client = new SecretsManagerClient({})) {
  for (const [setting, names] of SECRETS) {
    if (!env[setting]) continue;
    const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: env[setting] }));
    const values = JSON.parse(SecretString);
    // Only names we expect, and only when present: a missing field stays unset, so the code
    // reports "not configured" instead of using the text "undefined".
    for (const name of names) if (values[name]) env[name] = values[name];
  }
}

let ready; // once per Lambda instance; warm starts reuse it

module.exports.handler = async (event) => {
  ready = ready || loadSecrets().catch((err) => { ready = null; throw err; });
  await ready;
  // Required after the secrets are loaded: db/pool.js reads DATABASE_URL when it is first loaded.
  const { handle } = require('../services/audit-alerts/worker');
  return handle(event); // SQS messages, or a scheduled { task: "sweep" | "daily-summary" }
};

module.exports.loadSecrets = loadSecrets;
