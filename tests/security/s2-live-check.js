// S2 security tests (docs/api-test-plan.md: ST-03, ST-04, ST-05, prod rule). Signs in as the
// seeded Developer, tries requests that MUST be refused, and prints expected vs actual.
// Nothing is changed: every request below is refused before any write.
//
// WHERE IT CAN RUN: on your PC (default, http://localhost:3000) or on a Vercel Preview URL.
// Those use Cloudflare's official Turnstile TEST keys, which accept the test token below.
// It cannot sign in on production, and that is correct: production has real Turnstile keys,
// so no script can log in there (that is what the bot check is for). Check production by hand.
//
// Usage (repo root):
//   1. Terminal 1:  npm run dev:api          (your .env needs NODE_ENV=development)
//   2. Terminal 2:  node --env-file=.env tests/security/s2-live-check.js [base-url]
// Needs SEED_PASSWORD in .env. The password is only sent to the app's own /auth/login.
const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
// Cloudflare's documented dummy token: only accepted by the test secret keys.
const TEST_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

let cookie = '';
async function call(method, path, { body, csrf, turnstile } = {}) {
  const headers = {};
  if (turnstile) headers['X-Turnstile-Token'] = turnstile;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await res.json().catch(() => null);
  return { status: res.status, json, requestId: res.headers.get('x-request-id') };
}

const rows = [];
function check(id, test, expected, actual, pass) {
  rows.push({ id, test, expected, actual, result: pass ? 'PASS' : 'FAIL' });
}

(async () => {
  if (!process.env.SEED_PASSWORD) {
    console.error('SEED_PASSWORD is not set. Run with: node --env-file=.env tests/security/s2-live-check.js');
    process.exitCode = 1; return;
  }
  let login;
  try {
    login = await call('POST', '/auth/login', {
      body: { email: 'dev@acme.test', password: process.env.SEED_PASSWORD }, turnstile: TEST_TURNSTILE_TOKEN,
    });
  } catch {
    console.error(`Could not reach ${BASE}. Start the API first in another terminal: npm run dev:api`);
    process.exitCode = 1; return;
  }
  if (login.status !== 200) {
    const code = login.json?.error?.code;
    const help = {
      BOT_CHECK_UNAVAILABLE: 'The server has no Turnstile keys. On your PC: add NODE_ENV=development to .env and restart "npm run dev:api".',
      BOT_CHECK_FAILED: 'This server uses REAL Turnstile keys (production), so a script cannot sign in. That is the bot check working. Run this against http://localhost:3000 or a Preview URL instead.',
      UNAUTHENTICATED: 'Wrong password: SEED_PASSWORD in .env is not the one this database was seeded with.',
      RATE_LIMITED: 'Too many failed logins for this account or IP. Wait 15 minutes.',
    }[code] ?? 'Unexpected answer.';
    console.error(`Login as dev@acme.test failed: ${login.status} ${code ?? ''}\n${help}`);
    process.exitCode = 1; return;
  }
  const me = await call('GET', '/auth/me');
  const csrf = me.json.csrfToken;
  const flags = await call('GET', '/flags?q=new-checkout');
  const flag = flags.json.items.find((f) => f.key === 'new-checkout');
  const { environments } = (await call('GET', `/rollouts/${flag.id}`)).json;
  const stagingBefore = environments.staging;

  // ST-04: a write without the CSRF token
  let r = await call('PUT', `/rollouts/${flag.id}/staging`, { body: { percentage: 10, version: stagingBefore.version } });
  check('ST-04', 'PUT /rollouts without X-CSRF-Token', '403 CSRF_INVALID', `${r.status} ${r.json?.error?.code}`, r.status === 403 && r.json?.error?.code === 'CSRF_INVALID');

  // ST-05: invalid input
  r = await call('PUT', `/rollouts/${flag.id}/staging`, { csrf, body: { percentage: 150, version: stagingBefore.version } });
  check('ST-05a', 'percentage: 150', '400 VALIDATION_ERROR', `${r.status} ${r.json?.error?.message}`, r.status === 400);
  r = await call('PUT', `/rollouts/${flag.id}/staging`, { csrf, body: { percentage: 'abc', version: stagingBefore.version } });
  check('ST-05b', 'percentage: "abc"', '400 VALIDATION_ERROR', `${r.status} ${r.json?.error?.message}`, r.status === 400);
  const stagingAfter = (await call('GET', `/rollouts/${flag.id}`)).json.environments.staging;
  check('ST-05c', 'row unchanged after the refused writes', `${stagingBefore.percentage}% v${stagingBefore.version}`,
    `${stagingAfter.percentage}% v${stagingAfter.version}`,
    stagingAfter.percentage === stagingBefore.percentage && stagingAfter.version === stagingBefore.version);

  // Prod rule: a Developer may not change prod (rollout, rules, preview)
  r = await call('PUT', `/rollouts/${flag.id}/prod`, { csrf, body: { percentage: 50, version: environments.prod.version } });
  check('PROD-1', 'Developer: PUT /rollouts/…/prod', '403 FORBIDDEN', `${r.status} ${r.json?.error?.code}`, r.status === 403);
  r = await call('POST', `/rollouts/${flag.id}/prod/rules`, { csrf, body: { userId: 'u-test', kind: 'allow' } });
  check('PROD-2', 'Developer: add a prod allow rule', '403 FORBIDDEN', `${r.status} ${r.json?.error?.code}`, r.status === 403);
  r = await call('POST', '/preview', { csrf, body: { flagKey: 'new-checkout', env: 'prod', userId: 'u-1' } });
  check('PROD-3', 'Developer: preview prod', '403 FORBIDDEN', `${r.status} ${r.json?.error?.code}`, r.status === 403);

  // Ownership: another team's (or a made-up) flag id answers 404, never 403
  r = await call('GET', '/rollouts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  check('ST-03', 'GET /rollouts for a flag id we do not own', '404 NOT_FOUND', `${r.status} ${r.json?.error?.code}`, r.status === 404);

  await call('POST', '/auth/logout', { csrf });
  console.log(`\nS2 live security check against ${BASE}  (${new Date().toISOString()})\n`);
  console.table(rows);
  const failed = rows.filter((x) => x.result === 'FAIL').length;
  console.log(failed ? `${failed} FAILED` : 'All passed. The three 403s are now on the Audit page as access.denied.');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
