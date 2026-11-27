// Safe attack traffic for the LIVE site, to watch on the Monitoring page (Live mode, 1 hour).
//
// Production uses real Cloudflare Turnstile keys, so no script can ever sign in there. That is
// the point: every login below is a bot, and the bot check refuses it BEFORE the password is
// checked. So nothing changes, nobody is locked out (login_attempts is never touched) and no
// GitHub issue is opened. What it does:
//   1. bots that try real accounts with no Turnstile token   -> 403, bot_check.failed (team Acme)
//   2. bots that send a forged Turnstile token               -> 403, Cloudflare says no (team Acme)
//   3. credential stuffing with emails that do not exist     -> 403, "Not tied to any team" row
//   4. reads without a session, and scanner paths            -> 401 / 404 (real traffic, not recorded)
// It sends about one request a second, so the page fills up while you watch.
//
// Usage (repo root): node tests/security/s3-live-traffic.js https://<site> --live
const BASE = (process.argv[2] || '').replace(/\/+$/, '');
if (!BASE || !process.argv.includes('--live')) {
  console.error('Usage: node tests/security/s3-live-traffic.js https://<site> --live');
  process.exit(2);
}
const API = `${BASE}/api/v1`;
const PACE_MS = 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const plan = [];
const login = (label, email, token) => plan.push({
  label, method: 'POST', path: '/auth/login',
  headers: { 'Content-Type': 'application/json', ...(token && { 'X-Turnstile-Token': token }) },
  body: JSON.stringify({ email, password: 'not-the-password-' + Math.random().toString(36).slice(2, 8) }),
  expect: 403,
});
for (let i = 0; i < 8; i += 1) login('bot, no token, real account', i % 2 ? 'dev@acme.test' : 'admin@acme.test');
for (let i = 0; i < 6; i += 1) login('bot, forged token, real account', 'admin@acme.test', `forged.${Math.random().toString(36).slice(2)}`);
for (let i = 0; i < 8; i += 1) login('stuffing, unknown email', `user${100 + i}@leaked-list.example`);
for (const path of ['/flags', '/audit', '/monitoring', '/alerts']) plan.push({ label: 'read with no session', method: 'GET', path, expect: 401 });
for (const path of ['/.env', '/.git/config', '/wp-login.php', '/api/v1/admin']) plan.push({ label: 'scanner probe', method: 'GET', url: `${BASE}${path}`, expect: 404 });
// Shuffle so it looks like mixed traffic, not three tidy blocks.
for (let i = plan.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [plan[i], plan[j]] = [plan[j], plan[i]]; }

(async () => {
  console.log(`${plan.length} requests to ${BASE}, about 1 per second. Open Monitoring → 1 hour → Go live.\n`);
  const tally = {};
  let unexpected = 0;
  for (const [i, step] of plan.entries()) {
    const started = Date.now();
    let status;
    let code = '';
    try {
      const res = await fetch(step.url ?? `${API}${step.path}`, { method: step.method, headers: step.headers, body: step.body, redirect: 'manual' });
      status = res.status;
      code = (await res.json().catch(() => null))?.error?.code ?? '';
    } catch (err) {
      status = `network error (${err.cause?.code ?? err.name})`;
    }
    const ok = status === step.expect;
    if (!ok) unexpected += 1;
    tally[step.label] = (tally[step.label] ?? 0) + 1;
    console.log(`${String(i + 1).padStart(2)}  ${ok ? 'ok ' : '!! '} ${String(status).padEnd(4)} ${code.padEnd(17)} ${step.method.padEnd(4)} ${(step.url ?? step.path).replace(BASE, '')}  · ${step.label} (${Date.now() - started} ms)`);
    await wait(PACE_MS);
  }
  console.log('\nSent:', Object.entries(tally).map(([k, v]) => `${v} × ${k}`).join(', '));
  console.log(unexpected ? `${unexpected} answers were not what was expected (see !! above).` : 'Every request was refused as expected.');
})();
