// S3 attack demonstration: real attacks against the running API, each one checked against the
// control that must stop it, with the request id as evidence. Then the Monitoring numbers.
//
// RUN IT ONLY AGAINST YOUR OWN LOCAL STACK OR A PREVIEW. It creates test flags, makes 12 wrong
// logins (locking admin@acme.test and this IP out for 15 minutes) and, with an API key, sends
// 125 evaluations to trip the rate limit. Never point it at production.
//
// Usage (repo root, API running with NODE_ENV=development, Turnstile test keys):
//   node --env-file=<env with SEED_PASSWORD> tests/security/s3-attack-demo.js [base-url]
//   ATTACK_API_KEY=ffm_stg_...   optional: also runs the API key attacks (A9)
//   ATTACK_JSON=out.json         optional: also writes the results as JSON (for the evidence pack)
// Re-running within 15 minutes needs `DELETE FROM login_attempts` on that local database first.
const fs = require('node:fs');

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const PASSWORD = process.env.SEED_PASSWORD;
const KEY = process.env.ATTACK_API_KEY;
const TEST_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'; // only the Turnstile TEST secret accepts it

if (!PASSWORD) { console.error('SEED_PASSWORD is not set.'); process.exit(2); }
if (new URL(BASE).hostname === 'feature-flag-manager-cyan.vercel.app') {
  console.error('That is the production URL. Run it locally or on a Preview only.'); process.exit(2);
}

// ---------- tiny HTTP client with its own cookie jar per actor ----------
function client(name) {
  let cookie = '';
  let csrf = '';
  async function call(method, path, { body, rawBody, headers = {}, auth = true, useCsrf = true, url } = {}) {
    const h = { ...headers };
    if (auth && cookie) h.Cookie = cookie;
    if (useCsrf && csrf && method !== 'GET') h['X-CSRF-Token'] = csrf;
    if ((body !== undefined || rawBody !== undefined) && !h['Content-Type']) h['Content-Type'] = 'application/json';
    const res = await fetch(url ?? `${API}${path}`, { method, headers: h, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set && auth) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV or HTML */ }
    return { status: res.status, json, text, requestId: res.headers.get('x-request-id') };
  }
  return {
    name,
    call,
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async login(email, password = PASSWORD) {
      const r = await call('POST', '/auth/login', { body: { email, password }, headers: { 'X-Turnstile-Token': TEST_TURNSTILE_TOKEN }, useCsrf: false });
      if (r.status === 200) csrf = (await call('GET', '/auth/me')).json.csrfToken;
      return r;
    },
  };
}

// ---------- result table ----------
const results = [];
function check(id, attack, defence, expected, response, ok) {
  results.push({ id, attack, defence, expected, actual: response.status, pass: Boolean(ok), requestId: response.requestId });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${id.padEnd(4)} ${attack.padEnd(54).slice(0, 54)} expected ${String(expected).padEnd(9)} got ${response.status}  ${response.requestId ?? ''}`);
}
const section = (title) => console.log(`\n== ${title} ==`);

(async () => {
  console.log(`Attack demo against ${BASE}  (${new Date().toISOString()})`);
  const admin = client('admin@acme.test');
  const dev = client('dev@acme.test');
  const globex = client('admin@globex.test');
  const anon = client('anonymous');

  // Sessions first: the brute-force attack at the end locks this IP out.
  for (const [c, email] of [[admin, 'admin@acme.test'], [dev, 'dev@acme.test'], [globex, 'admin@globex.test']]) {
    const r = await c.login(email);
    if (r.status !== 200) { console.error(`Could not sign in as ${email}: ${r.status} ${r.text.slice(0, 120)}`); process.exit(1); }
  }
  const flags = (await admin.call('GET', '/flags?limit=5')).json.items;
  const target = flags[0];
  console.log(`Signed in as 3 users. Target flag: ${target.key} (${target.id})`);

  section('A1 · Unauthenticated access');
  for (const path of ['/flags', '/audit', '/monitoring', '/alerts']) {
    const r = await anon.call('GET', path);
    check('A1', `read ${path} with no session`, 'requireAuth', 401, r, r.status === 401 && !JSON.stringify(r.json).includes('items'));
  }

  section('A2 · Scripted login without the bot check');
  {
    const r = await anon.call('POST', '/auth/login', { body: { email: 'admin@acme.test', password: PASSWORD } });
    check('A2', 'login with no Turnstile token (a bot)', 'Turnstile', 403, r, r.status === 403 && r.json?.error?.code === 'BOT_CHECK_FAILED');
  }

  section('A3 · Privilege escalation: a Developer calls Admin-only endpoints');
  for (const [method, path, body] of [
    ['GET', '/monitoring'],
    ['GET', '/audit/export.csv'],
    ['GET', '/alerts'],
    ['PUT', '/alert-rules', { rules: [{ rule: 'prod_change', enabled: false }] }],
    ['PATCH', `/flags/${target.id}/environments/prod`, { enabled: !target.environments.prod.enabled, version: target.environments.prod.version }],
    ['DELETE', `/flags/${target.id}`],
  ]) {
    const r = await dev.call(method, path, { body });
    check('A3', `Developer ${method} ${path.replace(target.id, ':id')}`, 'requireRole + access.denied', 403, r, r.status === 403);
  }

  section('A4 · Cross-site request forgery');
  {
    const r = await admin.call('PUT', '/alert-rules', { body: { rules: [{ rule: 'prod_change', enabled: false }] }, useCsrf: false });
    check('A4', 'Admin cookie, no X-CSRF-Token (forged request)', 'csrf-sync', 403, r, r.status === 403 && r.json?.error?.code === 'CSRF_INVALID');
    const r2 = await admin.call('PUT', '/alert-rules', { body: { rules: [{ rule: 'prod_change', enabled: false }] }, useCsrf: false, headers: { 'X-CSRF-Token': 'guessed-token' } });
    check('A4', 'Admin cookie, guessed CSRF token', 'csrf-sync', 403, r2, r2.status === 403);
  }

  section('A5 · Cross-tenant access (IDOR): Globex reaches for Acme data');
  {
    const r = await globex.call('GET', `/flags/${target.id}`);
    check('A5', "Globex reads Acme's flag by id", 'team_id from session', 404, r, r.status === 404);
    const r2 = await globex.call('PATCH', `/flags/${target.id}/environments/prod`, { body: { enabled: true, version: target.environments.prod.version } });
    check('A5', "Globex toggles Acme's flag in prod", 'team_id from session', 404, r2, r2.status === 404);
    const r3 = await globex.call('GET', '/audit?actor=admin@acme.test');
    check('A5', "Globex searches the audit log for Acme's admin", 'team_id from session', '200, 0 rows', r3, r3.status === 200 && r3.json.items.length === 0);
  }

  section('A6 · SQL injection');
  for (const [path, test] of [
    [`/audit?actor=${encodeURIComponent("' OR '1'='1")}`, (r) => r.status === 200 && r.json.items.length === 0],
    [`/audit?action=${encodeURIComponent("flag.toggled'; DROP TABLE audit_events;--")}`, (r) => r.status === 400 || (r.status === 200 && r.json.items.length === 0)],
    [`/flags?q=${encodeURIComponent("%' OR 1=1 --")}`, (r) => r.status === 200 && r.json.items.length === 0],
    [`/alerts/${encodeURIComponent('1 OR 1=1')}/github-issue`, (r) => r.status === 400],
  ]) {
    const method = path.includes('github-issue') ? 'POST' : 'GET';
    const r = await admin.call(method, path);
    check('A6', `${method} ${decodeURIComponent(path).slice(0, 48)}`, 'parameterised SQL + zod', r.status === 400 ? 400 : '200, 0 rows', r, test(r));
  }
  {
    const r = await admin.call('GET', '/audit?limit=1');
    check('A6', 'audit_events still exists after the DROP attempt', '(proof)', 200, r, r.status === 200);
  }

  section('A7 · Mass assignment: create a flag "for" another team');
  const stamp = Date.now().toString(36);
  let massId;
  {
    const r = await admin.call('POST', '/flags', { body: { key: `attack-mass-${stamp}`, name: 'Mass assignment test', teamId: '00000000-0000-4000-8000-000000000000', team_id: 'globex', role: 'admin' } });
    massId = r.json?.id;
    const seen = await globex.call('GET', `/flags/${massId}`);
    check('A7', 'POST /flags with teamId/team_id/role in the body', 'extra fields dropped, team from session', '201 + 404', r, r.status === 201 && seen.status === 404);
  }

  section('A8 · Stored XSS and CSV formula injection');
  let xssId;
  {
    const payload = '<img src=x onerror=alert(document.cookie)>';
    const r = await admin.call('POST', '/flags', { body: { key: `attack-xss-${stamp}`, name: payload, description: '=HYPERLINK("http://evil.example","click")' } });
    xssId = r.json?.id;
    check('A8', 'flag name is an <img onerror> payload', 'stored as text, React escapes', 201, r, r.status === 201 && r.json.name === payload);
    const csv = await admin.call('GET', `/audit/export.csv?action=flag.created`);
    const formulaCells = csv.text.split('\n').filter((line) => /(^|,)"[=+\-@]/.test(line));
    check('A8', 'export CSV: no cell starts with = + - @', 'csv.cell() neutralises', '200, 0 cells', csv, csv.status === 200 && formulaCells.length === 0);
  }

  section('A9 · API key abuse on /evaluations');
  {
    const r = await anon.call('POST', '/evaluations', { body: { flagKey: target.key, userId: 'u-1' }, headers: { Authorization: 'Bearer ffm_stg_forged0000000000000000000000' }, auth: false });
    check('A9', 'forged API key', 'hashed key lookup', 401, r, r.status === 401);
    const r2 = await anon.call('POST', '/evaluations', { body: { flagKey: target.key, userId: 'u-1', env: 'prod' }, headers: { Authorization: `Bearer ${KEY ?? 'none'}` }, auth: false });
    if (KEY) check('A9', 'valid staging key asks for env=prod in the body', 'env comes from the key only', 400, r2, r2.status === 400);
    if (KEY) {
      let first429 = null;
      let last;
      for (let i = 1; i <= 125; i += 1) {
        last = await anon.call('POST', '/evaluations', { body: { flagKey: target.key, userId: `u-${i}` }, headers: { Authorization: `Bearer ${KEY}` }, auth: false });
        if (last.status === 429 && first429 === null) first429 = i;
      }
      check('A9', `flood: 125 evaluations in a minute (first 429 at #${first429})`, 'per-key limit 120/min', 429, last, first429 !== null && first429 <= 121);
    } else {
      console.log('skip  A9   flood + env tampering: set ATTACK_API_KEY to run them');
    }
  }

  section('A10 · Scanning and path traversal');
  for (const path of ['/.env', '/.git/config', '/api/v1/../../etc/passwd', '/api/v1/admin', '/wp-login.php']) {
    const r = await anon.call('GET', null, { url: `${BASE}${path}` });
    const leaks = /DATABASE_URL|SESSION_SECRET|root:x:0|\[core\]|at .*\.js:\d+/.test(r.text);
    check('A10', `GET ${path}`, 'no such route, no stack trace', '4xx, no leak', r, !leaks && r.status >= 400 && r.status < 500);
  }

  section('A11 · Malformed and oversized requests');
  {
    const r = await admin.call('POST', '/flags', { rawBody: '{"key": "broken", "name": ' });
    check('A11', 'invalid JSON body', 'json parser -> 400', 400, r, r.status === 400);
    const r2 = await admin.call('POST', '/flags', { body: { key: `attack-big-${stamp}`, name: 'x', description: 'A'.repeat(20000) } });
    check('A11', '20 kB body (limit 10 kB)', 'express.json limit', 413, r2, r2.status === 413);
    const r3 = await admin.call('POST', '/flags', { rawBody: 'key=x', headers: { 'Content-Type': 'text/plain' } });
    check('A11', 'text/plain body (CSRF-style form post)', 'require-json -> 415', 415, r3, r3.status === 415);
  }

  section('A12 · Session replay after logout');
  {
    const victim = client('dev (second session)');
    await victim.login('dev@acme.test');
    const stolen = victim.cookie;
    await victim.call('POST', '/auth/logout');
    const thief = client('thief');
    thief.cookie = stolen;
    const r = await thief.call('GET', '/flags');
    check('A12', 'reuse a session cookie after the user signed out', 'session destroyed server-side', 401, r, r.status === 401);
  }

  section('A13 · Brute force: 12 wrong passwords for admin@acme.test');
  {
    const attacker = client('attacker');
    const codes = [];
    let last;
    for (let i = 0; i < 12; i += 1) {
      last = await attacker.login('admin@acme.test', `wrong-password-${i}`);
      codes.push(last.status);
    }
    const locked = codes.indexOf(429) + 1;
    console.log(`      responses: ${codes.join(' ')}`);
    check('A13', `12 wrong passwords (locked out from attempt #${locked})`, 'login_attempts lockout', 429, last, locked > 0 && locked <= 6);
    const right = await attacker.login('admin@acme.test');
    check('A13', 'the RIGHT password while locked out', 'lockout holds 15 minutes', 429, right, right.status === 429);
    const alerts = await admin.call('GET', '/alerts');
    const raised = alerts.json.items.find((a) => a.rule === 'login_failures' && Date.now() - new Date(a.createdAt) < 5 * 60 * 1000);
    check('A13', 'login_failures alert raised for the team', 'alerts.raiseFor (10 in 15 min)', 'alert', { status: raised ? 'alert' : 'none', requestId: raised?.alertId }, Boolean(raised));
  }

  // Tidy up the test flags (archive, then delete): the audit log keeps every step.
  for (const id of [massId, xssId].filter(Boolean)) {
    const f = (await admin.call('GET', `/flags/${id}`)).json;
    const archived = await admin.call('PATCH', `/flags/${id}`, { body: { archived: true, version: f.version } });
    if (archived.status === 200) await admin.call('DELETE', `/flags/${id}`);
  }

  section('What Monitoring shows now (last hour, Acme)');
  const m = (await admin.call('GET', '/monitoring?hours=1')).json;
  console.log(`  failed logins ${m.failedLogins} · refused (403) ${m.forbidden} · bot checks failed ${m.botCheckFailures} · rate limited ${m.rateLimited} · 5xx ${m.serverErrors}`);
  console.log(`  most refused: ${m.topRefusedEndpoints.map((e) => `${e.endpoint} ×${e.count}`).join(', ')}`);
  console.log(`  attacking IPs: ${m.topFailedLoginIps.map((e) => `${e.ip} ×${e.count}`).join(', ')}`);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} of ${results.length} attacks were stopped as expected.`);
  if (process.env.ATTACK_JSON) fs.writeFileSync(process.env.ATTACK_JSON, JSON.stringify({ base: BASE, at: new Date().toISOString(), results, monitoring: m }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
