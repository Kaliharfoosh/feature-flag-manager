// Evidence script: asks the LIVE Feature Flag Manager the same question with three API keys
// (dev, staging, prod) and prints the answers side by side.
//
// Same user, same flags, same endpoint (POST /api/v1/evaluations/batch). The only thing that
// changes is the key, and the key alone decides which environment is read. So the three columns
// should follow the Development, Staging and Production cards on each flag's rollout page.
//
// Usage (from the repo root):
//   npm run check:envs                 (user u-981, every Acme Store flag)
//   npm run check:envs -- u-beta-1     (another user)
// Keys come from .env.envcheck (git-ignored). Only the key prefix is ever printed.
const { STORE_FLAG_KEYS } = require('../../demo-client/lib/store-flags');

const ENVS = [
  { name: 'dev', label: 'Development', keyVar: 'FFM_KEY_DEV' },
  { name: 'staging', label: 'Staging', keyVar: 'FFM_KEY_STAGING' },
  { name: 'prod', label: 'Production', keyVar: 'FFM_KEY_PROD' },
];

async function ask(apiUrl, apiKey, userId, flagKeys) {
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/evaluations/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ userId, flagKeys }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function main() {
  const apiUrl = process.env.FFM_API_URL;
  const userId = process.argv[2] || 'u-981';
  if (!apiUrl) throw new Error('FFM_API_URL is missing. Run with --env-file=.env.envcheck.');

  console.log(`Feature Flag Manager: ${apiUrl}`);
  console.log(`User: ${userId}    Time: ${new Date().toISOString()}`);
  console.log('Same request three times; only the API key changes.\n');

  const answers = {};
  for (const env of ENVS) {
    const key = process.env[env.keyVar];
    if (!key) throw new Error(`${env.keyVar} is missing from .env.envcheck.`);
    const { status, body } = await ask(apiUrl, key, userId, STORE_FLAG_KEYS);
    if (status !== 200) throw new Error(`${env.label} key: HTTP ${status} ${body?.error?.code ?? ''}`);
    answers[env.name] = body;
    console.log(`${env.label.padEnd(12)} key ${key.slice(0, 14)}...  -> HTTP ${status}, API says env = "${body.env}"`);
  }

  const width = Math.max(...STORE_FLAG_KEYS.map((k) => k.length)) + 2;
  const cell = (v) => (v === true ? 'ON' : 'off').padEnd(13);
  console.log(`\n${'Flag'.padEnd(width)}${ENVS.map((e) => e.label.padEnd(13)).join('')}`);
  console.log('-'.repeat(width + 13 * ENVS.length));
  for (const flag of STORE_FLAG_KEYS) {
    console.log(`${flag.padEnd(width)}${ENVS.map((e) => cell(answers[e.name].flags?.[flag])).join('')}`);
  }
  console.log('-'.repeat(width + 13 * ENVS.length));
  const onCount = (e) => STORE_FLAG_KEYS.filter((f) => answers[e.name].flags?.[f] === true).length;
  console.log(`${'Flags ON'.padEnd(width)}${ENVS.map((e) => `${onCount(e)} / ${STORE_FLAG_KEYS.length}`.padEnd(13)).join('')}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
