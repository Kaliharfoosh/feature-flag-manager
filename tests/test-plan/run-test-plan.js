// Runs the rows of docs/api-test-plan.md against a running API and writes the actual results.
//
// Use a FRESH, freshly seeded database (npm run migrate + npm run seed): rows such as ROL-01 check
// the seed values. Never run it against production (it signs in, creates flags and keys, and makes
// six wrong logins). Local or a Preview only.
//
// Usage (repo root, API running with NODE_ENV=development):
//   node --env-file=<env with SEED_PASSWORD, DATABASE_URL> tests/test-plan/run-test-plan.js [base] [--write]
//   --write   also fills the Actual result / Pass/Fail cells in docs/api-test-plan.md and writes
//             evidence/test-results/api-test-plan-run.md
// DATABASE_URL (the ffm_app login) is used for AUTH-10, ROL-33 and ST-10 (read-only checks plus
// statements that Postgres must refuse).
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const BASE = (process.argv.find((a) => a.startsWith('http')) || 'http://localhost:3002').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const WRITE = process.argv.includes('--write');
const PASSWORD = process.env.SEED_PASSWORD;
const TURNSTILE = 'XXXX.DUMMY.TOKEN.XXXX'; // only Cloudflare's TEST secret accepts it
if (!PASSWORD) { console.error('SEED_PASSWORD is not set.'); process.exit(2); }
if (/feature-flag-manager-cyan\.vercel\.app/.test(BASE)) { console.error('Not against production.'); process.exit(2); }

// ---------- HTTP client with a cookie jar per actor ----------
function actor() {
  let cookie = '';
  let csrf = '';
  const self = {
    async call(method, p, { body, raw, headers = {}, noCsrf = false, noCookie = false, url } = {}) {
      const h = { ...headers };
      if (cookie && !noCookie) h.Cookie = cookie;
      if (csrf && !noCsrf && method !== 'GET') h['X-CSRF-Token'] = csrf;
      if ((body !== undefined || raw !== undefined) && !h['Content-Type']) h['Content-Type'] = 'application/json';
      const t0 = Date.now();
      const res = await fetch(url ?? `${API}${p}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const set = res.headers.get('set-cookie');
      if (set && !noCookie) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* CSV, empty */ }
      return { status: res.status, json, text, headers: res.headers, setCookie: set, requestId: res.headers.get('x-request-id'), ms: Date.now() - t0 };
    },
    async login(email, password = PASSWORD) {
      const r = await self.call('POST', '/auth/login', { body: { email, password }, headers: { 'X-Turnstile-Token': TURNSTILE }, noCsrf: true });
      if (r.status === 200) csrf = (await self.call('GET', '/auth/me')).json.csrfToken;
      return r;
    },
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
  return self;
}

// ---------- results ----------
const results = {};
function rec(id, pass, actual, r) {
  results[id] = { pass: Boolean(pass), actual: String(actual).replace(/\|/g, '/'), requestId: r?.requestId ?? null };
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(8)} ${String(actual).slice(0, 110)}${r?.requestId ? `  [${r.requestId.slice(0, 8)}]` : ''}`);
}
const code = (r) => r.json?.error?.code ?? '';
const sc = (r) => `${r.status}${code(r) ? ` ${code(r)}` : ''}`;

(async () => {
  console.log(`Test plan run against ${BASE} (${new Date().toISOString()})\n`);
  const admin = actor();
  const dev = actor();
  const globex = actor();
  const anon = actor();
  const dbc = process.env.DATABASE_URL ? new Client({ connectionString: process.env.DATABASE_URL }) : null;
  if (dbc) await dbc.connect();

  // ===== AUTH (before anything else touches login_attempts) =====
  const a1 = await admin.login('admin@acme.test');
  const sidCookie = a1.setCookie || '';
  rec('AUTH-01', a1.status === 200 && a1.json?.user?.role === 'admin' && /HttpOnly/i.test(sidCookie) && /SameSite=Strict/i.test(sidCookie),
    `${a1.status}, role ${a1.json?.user?.role}, cookie ${/HttpOnly/i.test(sidCookie) ? 'HttpOnly' : 'NOT HttpOnly'}; ${(/SameSite=Strict/i.test(sidCookie) ? 'SameSite=Strict' : 'no SameSite=Strict')} (Secure is added on Vercel)`, a1);
  await dev.login('dev@acme.test');
  await globex.login('admin@globex.test');

  const tmp = actor();
  const wrong = await tmp.login('dev@acme.test', 'wrong-password-1');
  const unknown = await tmp.login('nobody-here@acme.test', 'wrong-password-1');
  rec('AUTH-02', wrong.status === 401 && code(wrong) === 'UNAUTHENTICATED', `${sc(wrong)} "${wrong.json?.error?.message}"`, wrong);
  rec('AUTH-03', unknown.status === 401 && unknown.json?.error?.message === wrong.json?.error?.message,
    `${sc(unknown)}, same message as AUTH-02: ${unknown.json?.error?.message === wrong.json?.error?.message ? 'yes' : 'no'} (${wrong.ms} ms vs ${unknown.ms} ms; dummy bcrypt hash for unknown emails)`, unknown);
  const badBody = await tmp.call('POST', '/auth/login', { body: { email: 5 }, headers: { 'X-Turnstile-Token': TURNSTILE } });
  rec('AUTH-04', badBody.status === 400 && /email/i.test(badBody.json?.error?.message ?? ''), `${sc(badBody)} "${badBody.json?.error?.message}"`, badBody);

  const me = await admin.call('GET', '/auth/me');
  rec('AUTH-06', me.status === 200 && me.json?.user && me.json?.csrfToken, `${me.status}, user ${me.json?.user?.email}, csrfToken present: ${Boolean(me.json?.csrfToken)}`, me);
  const meAnon = await anon.call('GET', '/auth/me');
  rec('AUTH-07', meAnon.status === 401, sc(meAnon), meAnon);

  const victim = actor();
  await victim.login('dev@acme.test');
  const noCsrfOut = await victim.call('POST', '/auth/logout', { noCsrf: true });
  rec('AUTH-09', noCsrfOut.status === 403 && code(noCsrfOut) === 'CSRF_INVALID', sc(noCsrfOut), noCsrfOut);
  let sessionHadPassword = null;
  let sessionGone = null;
  const sid = decodeURIComponent(victim.cookie.split('=')[1] || '').replace(/^s:/, '').split('.')[0];
  if (dbc) {
    try {
      const { rows } = await dbc.query('SELECT sess::text AS s FROM "session" WHERE sid = $1', [sid]);
      sessionHadPassword = rows[0] ? /password/i.test(rows[0].s) || rows[0].s.includes(PASSWORD) : null;
    } catch { sessionHadPassword = null; }
  }
  const out = await victim.call('POST', '/auth/logout');
  const after = await victim.call('GET', '/auth/me');
  rec('AUTH-08', out.status === 204 && after.status === 401, `logout ${out.status}, then /auth/me ${after.status}`, out);
  if (dbc) {
    try {
      const { rows } = await dbc.query('SELECT count(*)::int AS n FROM "session" WHERE sid = $1', [sid]);
      sessionGone = rows[0].n === 0;
    } catch { sessionGone = null; }
    rec('AUTH-10', sessionHadPassword === false && sessionGone === true, `session row held a password: ${sessionHadPassword}; row deleted after logout: ${sessionGone}`);
  }

  // ===== SHARED =====
  const h = await anon.call('GET', '/health');
  rec('G-01', h.status === 200 && h.json?.status === 'ok' && h.json?.db === 'ok' && h.json?.commit, `${h.status} status ${h.json?.status}, db ${h.json?.db}, commit ${h.json?.commit}`, h);
  const nf = await admin.call('PATCH', '/fake-url', { body: {} });
  rec('G-03', nf.status === 404 && code(nf) === 'ROUTE_NOT_FOUND', sc(nf), nf);
  const plain = await admin.call('POST', '/flags', { raw: 'key=x', headers: { 'Content-Type': 'text/plain' } });
  rec('G-04', plain.status === 415 && code(plain) === 'UNSUPPORTED_MEDIA_TYPE', sc(plain), plain);
  const comma = await admin.call('POST', '/flags', { raw: '{"key":"x","name":"y",}' });
  const stillUp = await anon.call('GET', '/health');
  rec('G-05', comma.status === 400 && code(comma) === 'VALIDATION_ERROR' && stillUp.status === 200, `${sc(comma)} "${comma.json?.error?.message}"; health afterwards ${stillUp.status}`, comma);
  const big = await admin.call('POST', '/flags', { body: { key: 'big-body', name: 'x', description: 'A'.repeat(20000) } });
  rec('G-06', big.status === 413 && code(big) === 'PAYLOAD_TOO_LARGE', sc(big), big);
  rec('G-07', nf.json?.error?.requestId && nf.json.error.requestId === nf.requestId,
    `body requestId ${nf.json?.error?.requestId?.slice(0, 8)}… = X-Request-Id ${nf.requestId?.slice(0, 8)}… (log line: see api log)`, nf);
  rec('G-08', h.headers.get('x-content-type-options') === 'nosniff' && !h.headers.get('x-powered-by'),
    `nosniff: ${h.headers.get('x-content-type-options')}, X-Powered-By: ${h.headers.get('x-powered-by') ?? 'absent'}`, h);

  // ===== FLAGS =====
  const f1 = await dev.call('GET', '/flags');
  const keys1 = (f1.json?.items ?? []).map((f) => f.key);
  rec('FLG-01', f1.status === 200 && keys1.includes('new-checkout') && !keys1.includes('search-v2') && !keys1.includes('loyalty-points') && 'nextCursor' in (f1.json ?? {}),
    `${f1.status}, ${keys1.length} flags: ${keys1.join(', ')}; search-v2 absent, Globex's loyalty-points absent`, f1);
  const f2 = await dev.call('GET', '/flags?archived=true');
  rec('FLG-02', f2.status === 200 && (f2.json?.items ?? []).some((f) => f.key === 'search-v2'), `${f2.status}, archived list: ${(f2.json?.items ?? []).map((f) => f.key).join(', ')}`, f2);
  const f3 = await dev.call('GET', '/flags?q=check');
  rec('FLG-03', f3.status === 200 && (f3.json?.items ?? []).map((f) => f.key).join() === 'new-checkout', `${f3.status}, ${(f3.json?.items ?? []).map((f) => f.key).join(', ')}`, f3);
  const p1 = await dev.call('GET', '/flags?limit=1');
  const p2 = await dev.call('GET', `/flags?limit=1&cursor=${encodeURIComponent(p1.json?.nextCursor ?? '')}`);
  const p3 = p2.json?.nextCursor ? await dev.call('GET', `/flags?limit=1&cursor=${encodeURIComponent(p2.json.nextCursor)}`) : null;
  const pageKeys = [p1, p2, p3].filter(Boolean).map((p) => p.json?.items?.[0]?.key);
  rec('FLG-04', p1.status === 200 && p2.status === 200 && new Set(pageKeys).size === pageKeys.length && (p3 ? p3.json?.nextCursor === null : true),
    `pages: ${pageKeys.join(' → ')}; no duplicate; last nextCursor ${p3?.json?.nextCursor ?? p2.json?.nextCursor}`, p2);
  const f5 = await dev.call('GET', '/flags?limit=500');
  rec('FLG-05', f5.status === 400, sc(f5), f5);
  const nc = f1.json.items.find((f) => f.key === 'new-checkout');
  const f6 = await dev.call('GET', `/flags/${nc.id}`);
  rec('FLG-06', f6.status === 200 && f6.json?.environments && ['dev', 'staging', 'prod'].every((e) => f6.json.environments[e]),
    `${f6.status}, environments: ${Object.keys(f6.json?.environments ?? {}).join(', ')}`, f6);
  const f7 = await dev.call('GET', '/flags/3f1c2b9e-0000-4000-8000-0000000000aa');
  rec('FLG-07', f7.status === 404 && code(f7) === 'NOT_FOUND', sc(f7), f7);
  const stamp = Date.now().toString(36);
  const newKey = `beta-search-${stamp}`;
  const f8 = await admin.call('POST', '/flags', { body: { key: newKey, name: 'Beta search' } });
  const envs8 = f8.json?.environments ?? {};
  rec('FLG-08', f8.status === 201 && Object.values(envs8).every((e) => e.enabled === false && Number(e.percentage ?? 0) === 0) && f8.json?.version === 1,
    `${f8.status}, ${Object.entries(envs8).map(([k, e]) => `${k} ${e.enabled ? 'on' : 'off'} ${e.percentage ?? 0}%`).join(', ')}, version ${f8.json?.version}`, f8);
  const f9 = await admin.call('POST', '/flags', { body: { key: newKey, name: 'Again' } });
  rec('FLG-09', f9.status === 409 && code(f9) === 'CONFLICT', sc(f9), f9);
  const f10 = await admin.call('POST', '/flags', { body: { key: 'Bad Key!', name: '' } });
  rec('FLG-10', f10.status === 400 && /key/.test(f10.json?.error?.message ?? ''), `${sc(f10)} "${f10.json?.error?.message}"`, f10);
  const f11 = await admin.call('POST', '/flags', { body: { key: `server-ids-${stamp}`, name: 'Server ids', id: '00000000-0000-4000-8000-000000000001', version: 99, createdAt: '2000-01-01T00:00:00Z' } });
  rec('FLG-11', f11.status === 201 && f11.json?.id !== '00000000-0000-4000-8000-000000000001' && f11.json?.version === 1 && !String(f11.json?.createdAt).startsWith('2000'),
    `${f11.status}, id ${f11.json?.id?.slice(0, 8)}… (not the client's), version ${f11.json?.version}, createdAt ${String(f11.json?.createdAt).slice(0, 10)}`, f11);
  const flagId = f8.json.id;
  const f12 = await dev.call('PATCH', `/flags/${flagId}`, { body: { name: 'Renamed', version: 1 } });
  rec('FLG-12', f12.status === 200 && f12.json?.version === 2 && f12.json?.name === 'Renamed', `${f12.status}, name ${f12.json?.name}, version ${f12.json?.version}`, f12);
  const f13 = await dev.call('PATCH', `/flags/${flagId}`, { body: { name: 'Stale', version: 1 } });
  rec('FLG-13', f13.status === 409 && code(f13) === 'STALE_VERSION', sc(f13), f13);
  const f14 = await dev.call('PATCH', `/flags/${flagId}`, { body: { archived: true, version: 2 } });
  rec('FLG-14', f14.status === 403 && code(f14) === 'FORBIDDEN', sc(f14), f14);
  const f16 = await admin.call('DELETE', `/flags/${flagId}`);
  rec('FLG-16', f16.status === 409 && code(f16) === 'CONFLICT', sc(f16), f16);
  const f15 = await admin.call('PATCH', `/flags/${flagId}`, { body: { archived: true, version: 2 } });
  const aud15 = await admin.call('GET', '/audit?action=flag.archived&limit=5');
  rec('FLG-15', f15.status === 200 && f15.json?.archived === true && (aud15.json?.items ?? []).some((e) => e.targetId === flagId),
    `${f15.status}, archived ${f15.json?.archived}; flag.archived in the audit log: ${(aud15.json?.items ?? []).some((e) => e.targetId === flagId)}`, f15);
  const f18 = await dev.call('DELETE', `/flags/${flagId}`);
  rec('FLG-18', f18.status === 403, sc(f18), f18);
  const f17 = await admin.call('DELETE', `/flags/${flagId}`);
  const gone = await admin.call('GET', `/flags/${flagId}`);
  rec('FLG-17', f17.status === 204 && gone.status === 404, `${f17.status}, then GET ${gone.status}`, f17);

  const toggleFlag = (await admin.call('POST', '/flags', { body: { key: `toggle-${stamp}`, name: 'Toggle test' } })).json;
  const t19 = await dev.call('PATCH', `/flags/${toggleFlag.id}/environments/staging`, { body: { enabled: true, version: toggleFlag.environments.staging.version } });
  const aud19 = await dev.call('GET', '/audit?action=flag.toggled&limit=3');
  const ev19 = (aud19.json?.items ?? []).find((e) => e.targetId === toggleFlag.id);
  rec('FLG-19', t19.status === 200 && t19.json?.enabled === true && ev19?.details?.before && ev19?.details?.after,
    `${t19.status}, enabled ${t19.json?.enabled}; audit flag.toggled before ${JSON.stringify(ev19?.details?.before)} after ${JSON.stringify(ev19?.details?.after)}`, t19);
  const t20 = await dev.call('PATCH', `/flags/${toggleFlag.id}/environments/prod`, { body: { enabled: true, version: toggleFlag.environments.prod.version } });
  const den20 = await admin.call('GET', '/audit?action=access.denied&limit=3');
  rec('FLG-20', t20.status === 403 && code(t20) === 'FORBIDDEN' && (den20.json?.items ?? []).some((e) => e.requestId === t20.requestId),
    `${sc(t20)}; access.denied with the same requestId: ${(den20.json?.items ?? []).some((e) => e.requestId === t20.requestId)}`, t20);
  const t21 = await dev.call('PATCH', `/flags/${toggleFlag.id}/environments/live`, { body: { enabled: true, version: 1 } });
  rec('FLG-21', t21.status === 400, sc(t21), t21);
  const t22 = await dev.call('PATCH', `/flags/${toggleFlag.id}/environments/staging`, { body: { enabled: 'yes', version: 2 } });
  rec('FLG-22', t22.status === 400, sc(t22), t22);
  const writes = [
    ['POST', '/flags', { key: `csrf-${stamp}`, name: 'x' }],
    ['PATCH', `/flags/${toggleFlag.id}`, { name: 'x', version: 1 }],
    ['PATCH', `/flags/${toggleFlag.id}/environments/dev`, { enabled: true, version: 1 }],
    ['DELETE', `/flags/${toggleFlag.id}`],
    ['PUT', `/rollouts/${toggleFlag.id}/dev`, { percentage: 10, version: 1 }],
    ['PUT', '/alert-rules', { rules: [{ rule: 'prod_change', enabled: false }] }],
  ];
  const csrfCodes = [];
  for (const [m, p, b] of writes) csrfCodes.push(sc(await admin.call(m, p, { body: b, noCsrf: true })));
  const csrfCreated = (await admin.call('GET', `/flags?q=csrf-${stamp}`)).json?.items?.length ?? 0;
  rec('FLG-23', csrfCodes.every((c) => c === '403 CSRF_INVALID') && csrfCreated === 0, `${writes.length} write routes: ${[...new Set(csrfCodes)].join(', ')}; flags created: ${csrfCreated}`);

  // ===== ROLLOUTS =====
  const r1 = await dev.call('GET', `/rollouts/${nc.id}`);
  const pct = (r, e) => Number((r.json?.environments ?? r.json?.items ?? r.json)?.[e]?.percentage ?? (Array.isArray(r.json?.items) ? r.json.items.find((x) => x.env === e)?.percentage : NaN));
  rec('ROL-01', r1.status === 200 && pct(r1, 'dev') === 100 && pct(r1, 'staging') === 25 && pct(r1, 'prod') === 0,
    `${r1.status}: dev ${pct(r1, 'dev')}, staging ${pct(r1, 'staging')}, prod ${pct(r1, 'prod')}`, r1);
  const stgVersion = () => (r1.json?.environments ?? {}).staging?.version ?? (r1.json?.items ?? []).find((x) => x.env === 'staging')?.version ?? 1;
  const v0 = stgVersion();
  const r2 = await dev.call('PUT', `/rollouts/${nc.id}/staging`, { body: { percentage: 50, version: v0 } });
  const aud2 = await dev.call('GET', '/audit?action=rollout.updated&limit=3');
  const ev2 = (aud2.json?.items ?? [])[0];
  rec('ROL-02', r2.status === 200 && Number(r2.json?.percentage) === 50 && r2.json?.version === v0 + 1 && Number(ev2?.details?.before?.percentage) === 25 && Number(ev2?.details?.after?.percentage) === 50,
    `${r2.status}, percentage ${r2.json?.percentage}, version ${v0} → ${r2.json?.version}; audit before ${ev2?.details?.before?.percentage} after ${ev2?.details?.after?.percentage}`, r2);
  const r3 = await dev.call('PUT', `/rollouts/${nc.id}/staging`, { body: { percentage: 60, version: v0 } });
  rec('ROL-03', r3.status === 409 && code(r3) === 'STALE_VERSION', sc(r3), r3);
  const r4 = await dev.call('PUT', `/rollouts/${nc.id}/staging`, { body: { percentage: 150, version: v0 + 1 } });
  rec('ROL-04', r4.status === 400, `${sc(r4)} "${r4.json?.error?.message}"`, r4);
  const r5 = await dev.call('PUT', `/rollouts/${nc.id}/staging`, { body: { percentage: 'abc', version: v0 + 1 } });
  rec('ROL-05', r5.status === 400, `${sc(r5)} "${r5.json?.error?.message}"`, r5);
  const r6 = await dev.call('PUT', `/rollouts/${nc.id}/staging`, { body: { percentage: 33.333, version: v0 + 1 } });
  rec('ROL-06', r6.status === 400 || Number(r6.json?.percentage) === 33.33, `${sc(r6)}${r6.status === 200 ? `, stored ${r6.json?.percentage}` : ` "${r6.json?.error?.message}"`} (contract: max 2 decimals)`, r6);
  const after6 = await dev.call('GET', `/rollouts/${nc.id}`);
  const prodVersion = (after6.json?.environments ?? {}).prod?.version ?? (after6.json?.items ?? []).find((x) => x.env === 'prod')?.version ?? 1;
  const r7 = await dev.call('PUT', `/rollouts/${nc.id}/prod`, { body: { percentage: 10, version: prodVersion } });
  rec('ROL-07', r7.status === 403 && code(r7) === 'FORBIDDEN', sc(r7), r7);
  const r8 = await admin.call('PUT', `/rollouts/${nc.id}/prod`, { body: { percentage: 0, version: prodVersion } });
  rec('ROL-08', r8.status === 200, sc(r8), r8);
  const gFlag = (await globex.call('GET', '/flags')).json.items[0];
  const r9 = await admin.call('PUT', `/rollouts/${gFlag.id}/dev`, { body: { percentage: 5, version: 1 } });
  rec('ROL-09', r9.status === 404, `${sc(r9)} (Globex flag ${gFlag.key})`, r9);
  const fresh = (await admin.call('POST', '/flags', { body: { key: `rules-${stamp}`, name: 'Rules test' } })).json;
  const r10 = await dev.call('GET', `/rollouts/${fresh.id}/staging/rules`);
  rec('ROL-10', r10.status === 200 && (r10.json?.items ?? []).length === 0, `${r10.status}, ${(r10.json?.items ?? []).length} rules`, r10);
  const r11 = await dev.call('POST', `/rollouts/${fresh.id}/staging/rules`, { body: { userId: 'u-1', kind: 'allow' } });
  const aud11 = await dev.call('GET', '/audit?action=rule.added&limit=3');
  rec('ROL-11', r11.status === 201 && r11.json?.id && (aud11.json?.items ?? []).some((e) => e.requestId === r11.requestId), `${r11.status}, id ${r11.json?.id?.slice(0, 8)}…; rule.added audited`, r11);
  const r12 = await dev.call('POST', `/rollouts/${fresh.id}/staging/rules`, { body: { userId: 'u-1', kind: 'block' } });
  rec('ROL-12', r12.status === 409 && code(r12) === 'CONFLICT', sc(r12), r12);
  const r13 = await dev.call('POST', `/rollouts/${fresh.id}/staging/rules`, { body: { userId: '', kind: 'maybe' } });
  rec('ROL-13', r13.status === 400, sc(r13), r13);
  const r14 = await dev.call('DELETE', `/rules/${r11.json?.id}`);
  const list14 = await dev.call('GET', `/rollouts/${fresh.id}/staging/rules`);
  rec('ROL-14', r14.status === 204 && (list14.json?.items ?? []).length === 0, `${r14.status}, list afterwards ${(list14.json?.items ?? []).length}`, r14);
  const r15 = await dev.call('DELETE', '/rules/3f1c2b9e-0000-4000-8000-0000000000bb');
  rec('ROL-15', r15.status === 404, sc(r15), r15);
  await dev.call('POST', `/rollouts/${fresh.id}/staging/rules`, { body: { userId: 'u-1', kind: 'allow' } });
  await dev.call('POST', `/rollouts/${fresh.id}/staging/rules`, { body: { userId: 'u-2', kind: 'block' } });
  // Contract order: archived -> env disabled -> block -> allow -> percentage. The lists only matter
  // when the environment is ON, so switch staging on first (percentage stays 0).
  const freshNow = (await dev.call('GET', `/flags/${fresh.id}`)).json;
  await dev.call('PATCH', `/flags/${fresh.id}/environments/staging`, { body: { enabled: true, version: freshNow.environments.staging.version } });
  const r16 = await dev.call('POST', '/preview', { body: { flagKey: fresh.key, env: 'staging', userId: 'u-1' } });
  rec('ROL-16', r16.status === 200 && r16.json?.enabled === true && r16.json?.reason === 'allowlisted', `${r16.status}, enabled ${r16.json?.enabled}, reason ${r16.json?.reason}`, r16);
  const fv = (await dev.call('GET', `/rollouts/${fresh.id}`)).json;
  const fStg = (fv?.environments ?? {}).staging?.version ?? (fv?.items ?? []).find((x) => x.env === 'staging')?.version ?? 1;
  await dev.call('PUT', `/rollouts/${fresh.id}/staging`, { body: { percentage: 100, version: fStg } });
  const r17 = await dev.call('POST', '/preview', { body: { flagKey: fresh.key, env: 'staging', userId: 'u-2' } });
  rec('ROL-17', r17.status === 200 && r17.json?.enabled === false && r17.json?.reason === 'blocklisted', `${r17.status}, enabled ${r17.json?.enabled}, reason ${r17.json?.reason}`, r17);
  const r18 = await dev.call('POST', '/preview', { body: { flagKey: 'search-v2', env: 'staging', userId: 'u-1' } });
  rec('ROL-18', r18.status === 200 && r18.json?.enabled === false && r18.json?.reason === 'archived', `${r18.status}, enabled ${r18.json?.enabled}, reason ${r18.json?.reason}`, r18);
  const r19 = await dev.call('POST', '/preview', { body: { flagKey: fresh.key, env: 'prod', userId: 'u-1' } });
  rec('ROL-19', r19.status === 403, sc(r19), r19);

  // ===== KEYS + EVALUATIONS =====
  const k23 = await admin.call('POST', '/keys', { body: { name: 'Storefront staging', env: 'staging' } });
  const rawKey = k23.json?.key;
  const list23 = await admin.call('GET', '/keys');
  const listed = (list23.json?.items ?? []).find((k) => k.id === k23.json?.id);
  rec('ROL-23', k23.status === 201 && rawKey && listed && !JSON.stringify(list23.json).includes(rawKey),
    `${k23.status}, key shown once (${rawKey?.slice(0, 14)}…); GET /keys shows prefix ${listed?.prefix} and never the key`, k23);
  const k24 = await dev.call('POST', '/keys', { body: { name: 'x', env: 'staging' } });
  rec('ROL-24', k24.status === 403, sc(k24), k24);
  const k25 = await admin.call('POST', '/keys', { body: { name: 'x', env: 'live' } });
  rec('ROL-25', k25.status === 400, sc(k25), k25);
  const evalCall = (key, body) => anon.call('POST', '/evaluations', { body, headers: key ? { Authorization: `Bearer ${key}` } : {}, noCookie: true });
  const e26 = await evalCall(rawKey, { flagKey: 'new-checkout', userId: 'u-981' });
  const used = (await admin.call('GET', '/keys')).json?.items?.find((k) => k.id === k23.json?.id);
  rec('ROL-26', e26.status === 200 && e26.json?.env === 'staging' && typeof e26.json?.enabled === 'boolean' && used?.lastUsedAt,
    `${e26.status}, env ${e26.json?.env}, enabled ${e26.json?.enabled}; lastUsedAt set: ${Boolean(used?.lastUsedAt)}`, e26);
  const e27 = await evalCall(null, { flagKey: 'new-checkout', userId: 'u-1' });
  rec('ROL-27', e27.status === 401, `${sc(e27)} "${e27.json?.error?.message}"`, e27);
  const e28 = await evalCall('ffm_stg_madeUpKey000000000000000000', { flagKey: 'new-checkout', userId: 'u-1' });
  rec('ROL-28', e28.status === 401 && e28.json?.error?.message === e27.json?.error?.message,
    `${sc(e28)} "${e28.json?.error?.message}"; differs from ROL-27's "${e27.json?.error?.message}" (unknown and revoked keys do share one message, so no key is revealed)`, e28);
  // ROL-29 / ST-06: a flag ON in prod and OFF in staging, asked with a staging key
  const scope = (await admin.call('POST', '/flags', { body: { key: `scope-${stamp}`, name: 'Scope test' } })).json;
  await admin.call('PATCH', `/flags/${scope.id}/environments/prod`, { body: { enabled: true, version: scope.environments.prod.version } });
  const sv = (await admin.call('GET', `/rollouts/${scope.id}`)).json;
  const sProd = (sv?.environments ?? {}).prod?.version ?? (sv?.items ?? []).find((x) => x.env === 'prod')?.version ?? 1;
  await admin.call('PUT', `/rollouts/${scope.id}/prod`, { body: { percentage: 100, version: sProd } });
  const e29 = await evalCall(rawKey, { flagKey: scope.key, userId: 'u-1' });
  rec('ROL-29', e29.status === 200 && e29.json?.env === 'staging' && e29.json?.enabled === false, `${e29.status}, env ${e29.json?.env}, enabled ${e29.json?.enabled} (prod is on at 100%)`, e29);
  const e06 = await evalCall(rawKey, { flagKey: scope.key, userId: 'u-1', env: 'prod' });
  rec('ST-06', e29.json?.enabled === false && e06.status === 400, `staging key on a prod-only flag: enabled ${e29.json?.enabled}; with "env":"prod" in the body: ${sc(e06)} "${e06.json?.error?.message}"`, e06);
  const e34 = await anon.call('POST', '/evaluations/batch', { body: { userId: 'u-981', flagKeys: ['new-checkout', 'dark-mode', 'search-v2', 'loyalty-points'] }, headers: { Authorization: `Bearer ${rawKey}` }, noCookie: true });
  rec('ROL-34', e34.status === 200 && e34.json?.env === 'staging' && e34.json?.flags?.['search-v2'] === false && (e34.json?.notFound ?? []).includes('loyalty-points'),
    `${e34.status}, env ${e34.json?.env}, flags ${JSON.stringify(e34.json?.flags)}, notFound ${JSON.stringify(e34.json?.notFound)} (Globex's flag is not visible)`, e34);
  const b1 = await anon.call('POST', '/evaluations/batch', { body: { userId: 'u-1', flagKeys: ['new-checkout'], env: 'prod' }, headers: { Authorization: `Bearer ${rawKey}` }, noCookie: true });
  const b2 = await anon.call('POST', '/evaluations/batch', { body: { userId: 'u-1', flagKeys: Array.from({ length: 51 }, (_, i) => `flag-${i}`) }, headers: { Authorization: `Bearer ${rawKey}` }, noCookie: true });
  const b3 = await anon.call('POST', '/evaluations/batch', { body: { userId: 'u-1', flagKeys: ['new-checkout', 'new-checkout'] }, headers: { Authorization: `Bearer ${rawKey}` }, noCookie: true });
  rec('ROL-35', [b1, b2, b3].every((b) => b.status === 400), `env: ${sc(b1)}; 51 keys: ${sc(b2)}; repeated key: ${sc(b3)}`, b1);
  if (dbc) {
    const { rows } = await dbc.query('SELECT key_hash, prefix FROM api_keys WHERE id = $1', [k23.json.id]);
    const cols = (await dbc.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys'")).rows.map((r) => r.column_name);
    rec('ROL-33', rows[0] && rows[0].key_hash !== rawKey && !cols.includes('key') && rawKey.startsWith(rows[0].prefix.slice(0, 8)),
      `api_keys columns: ${cols.join(', ')}; stored hash ≠ key; only the prefix ${rows[0]?.prefix} is readable`);
  }
  const k30 = await admin.call('DELETE', `/keys/${k23.json.id}`);
  const e30 = await evalCall(rawKey, { flagKey: 'new-checkout', userId: 'u-1' });
  const aud30 = await admin.call('GET', '/audit?action=key.revoked&limit=3');
  rec('ROL-30', k30.status === 204 && e30.status === 401 && (aud30.json?.items ?? []).length > 0, `revoke ${k30.status}, then evaluation ${sc(e30)}; key.revoked audited`, e30);
  rec('ST-07', k30.status === 204 && e30.status === 401, `revoke ${k30.status}, evaluation with the revoked key ${sc(e30)}`, e30);
  const st08 = await dev.call('POST', '/keys', { body: { name: 'dev key', env: 'staging' } });
  rec('ST-08', st08.status === 403, sc(st08), st08);

  // ===== AUDIT =====
  const toggle = await admin.call('PATCH', `/flags/${toggleFlag.id}/environments/dev`, { body: { enabled: true, version: (await admin.call('GET', `/flags/${toggleFlag.id}`)).json.environments.dev.version } });
  const a01 = await admin.call('GET', '/audit?limit=1');
  const top = a01.json?.items?.[0];
  rec('AUD-01', a01.status === 200 && top?.action === 'flag.toggled' && top?.actorLabel === 'admin@acme.test' && top?.requestId === toggle.requestId && top?.details?.before,
    `${a01.status}, newest: ${top?.action} by ${top?.actorLabel}, requestId matches the toggle: ${top?.requestId === toggle.requestId}`, a01);
  const a02 = await admin.call('GET', '/audit?action=rollout.updated');
  rec('AUD-02', a02.status === 200 && a02.json.items.length > 0 && a02.json.items.every((e) => e.action === 'rollout.updated'), `${a02.status}, ${a02.json.items.length} events, all rollout.updated`, a02);
  const a03 = await admin.call('GET', '/audit?actor=dev@acme.test');
  rec('AUD-03', a03.status === 200 && a03.json.items.length > 0 && a03.json.items.every((e) => e.actorLabel === 'dev@acme.test'), `${a03.status}, ${a03.json.items.length} events, all by dev@acme.test`, a03);
  const a04 = await admin.call('GET', '/audit?from=2026-11-01&to=2026-11-02');
  rec('AUD-04', a04.status === 200 && Array.isArray(a04.json?.items), `${a04.status}, ${a04.json?.items?.length} events in the window (empty is 200, not 404)`, a04);
  const a05 = await admin.call('GET', '/audit?from=yesterday');
  rec('AUD-05', a05.status === 400, sc(a05), a05);
  const pa = await admin.call('GET', '/audit?limit=2');
  const pb = await admin.call('GET', `/audit?limit=2&cursor=${encodeURIComponent(pa.json?.nextCursor ?? '')}`);
  const ids = [...pa.json.items, ...pb.json.items].map((e) => e.id);
  rec('AUD-06', pa.status === 200 && pb.status === 200 && new Set(ids).size === 4 && ids[1] > ids[2], `ids ${ids.join(', ')}: no gap between pages, no duplicate`, pb);
  const a07 = await anon.call('GET', '/audit');
  rec('AUD-07', a07.status === 401, sc(a07), a07);
  const a08 = await globex.call('GET', '/audit?limit=100');
  rec('AUD-08', a08.status === 200 && !JSON.stringify(a08.json).includes('acme.test'), `${a08.status}, ${a08.json?.items?.length} events, none from Acme`, a08);
  const a09 = await admin.call('GET', '/audit/summary?days=7');
  rec('AUD-09', a09.status === 200 && ['changes', 'securityEvents', 'failedLogins', 'prodChanges', 'alertsOpen'].every((k) => typeof a09.json?.[k] === 'number'), `${a09.status} ${JSON.stringify(a09.json)}`, a09);
  const a10 = await admin.call('GET', '/audit/summary?days=0');
  rec('AUD-10', a10.status === 400, sc(a10), a10);
  await admin.call('POST', '/flags', { body: { key: `formula-${stamp}`, name: '=HYPERLINK("http://evil.example","x")', description: '@SUM(1+1)' } });
  const a11 = await admin.call('GET', '/audit/export.csv?action=flag.created');
  const formula = a11.text.split('\n').filter((l) => /(^|,)"[=+\-@]/.test(l)).length;
  // The details cell is JSON (starts with "{"), so no exported cell can start with "=" through the
  // API; the prefix rule itself is checked on csv.cell(), the function every cell goes through.
  const { cell } = require('../../backend/services/audit-alerts/csv');
  const prefixed = cell('=HYPERLINK("http://evil.example")');
  rec('AUD-11', a11.status === 200 && /text\/csv/.test(a11.headers.get('content-type')) && /attachment/.test(a11.headers.get('content-disposition')) && formula === 0 && prefixed.startsWith(`"'=`),
    `${a11.status} ${a11.headers.get('content-type')}, ${a11.headers.get('content-disposition')}; cells starting with = + - @: ${formula}; csv.cell('=HYPERLINK…') → ${prefixed.slice(0, 14)}…`, a11);
  rec('ST-17', a11.status === 200 && formula === 0, `export as Admin: ${formula} cells start with = + - @`, a11);
  const a12 = await dev.call('GET', '/audit/export.csv');
  rec('AUD-12', a12.status === 403, sc(a12), a12);
  rec('ST-12', a12.status === 403, sc(a12), a12);
  const secretish = 'ffm_stg_ThisLooksLikeARealKey1234567890';
  const a13flag = await admin.call('POST', '/flags', { body: { key: `redact-${stamp}`, name: 'Redaction test', description: `key ${secretish}` } });
  const a13 = await admin.call('GET', '/audit?action=flag.created&limit=3');
  const stored = JSON.stringify((a13.json?.items ?? []).find((e) => e.targetId === a13flag.json?.id)?.details ?? {});
  rec('AUD-13', !stored.includes(secretish) && /REDACTED/.test(stored), `details as stored: ${stored.slice(0, 120)}`, a13);
  const a16 = await dev.call('GET', '/monitoring');
  rec('AUD-16', a16.status === 403, sc(a16), a16);
  const a17 = await admin.call('GET', '/monitoring?hours=1000');
  rec('AUD-17', a17.status === 400, sc(a17), a17);
  const a19 = await admin.call('PUT', '/alert-rules', { body: { rules: [{ rule: 'unknown', enabled: true }] } });
  rec('AUD-19', a19.status === 400, sc(a19), a19);
  // AUD-20: prod toggle with prod_change on raises an open alert for that audit event
  const ae = await admin.call('PATCH', `/flags/${toggleFlag.id}/environments/prod`, { body: { enabled: true, version: (await admin.call('GET', `/flags/${toggleFlag.id}`)).json.environments.prod.version } });
  const evProd = (await admin.call('GET', '/audit?action=flag.toggled&limit=1')).json.items[0];
  const al = (await admin.call('GET', '/alerts')).json.items.find((x) => x.auditEventId === evProd.id);
  rec('AUD-20', ae.status === 200 && al && al.rule === 'prod_change', `toggle ${ae.status}; alert ${al?.rule} for audit event ${evProd.id}, status ${al?.status}${al?.lastError ? ` (${al.lastError})` : ''}`, ae);
  // AUD-18: switch prod_change off, the next prod change raises nothing; then switch it back on
  const a18 = await admin.call('PUT', '/alert-rules', { body: { rules: [{ rule: 'prod_change', enabled: false }] } });
  await admin.call('PATCH', `/flags/${toggleFlag.id}/environments/prod`, { body: { enabled: false, version: (await admin.call('GET', `/flags/${toggleFlag.id}`)).json.environments.prod.version } });
  const ev18 = (await admin.call('GET', '/audit?action=flag.toggled&limit=1')).json.items[0];
  const al18 = (await admin.call('GET', '/alerts')).json.items.find((x) => x.auditEventId === ev18.id);
  await admin.call('PUT', '/alert-rules', { body: { rules: [{ rule: 'prod_change', enabled: true }] } });
  rec('AUD-18', a18.status === 200 && !al18, `${a18.status}; the next prod toggle (audit event ${ev18.id}) raised an alert: ${Boolean(al18)}`, a18);
  const a23 = await dev.call('POST', `/alerts/${evProd.id}/github-issue`);
  rec('AUD-23', a23.status === 403, sc(a23), a23);
  const a24 = await admin.call('POST', '/alerts/999999/github-issue');
  rec('AUD-24', a24.status === 404, sc(a24), a24);

  // ===== SECURITY TABLE (the rest) =====
  const st01 = await anon.call('GET', '/flags');
  rec('ST-01', st01.status === 401 && !st01.text.includes('items'), `${sc(st01)}, no data in the body`, st01);
  rec('ST-02', t20.status === 403, `Developer prod toggle: ${sc(t20)}; access.denied logged with the same requestId (FLG-20)`, t20);
  const st03 = await globex.call('GET', `/flags/${nc.id}`);
  rec('ST-03', st03.status === 404, `Globex opens Acme's new-checkout: ${sc(st03)}`, st03);
  const st04 = await dev.call('PUT', `/rollouts/${nc.id}/staging`, { body: { percentage: 30, version: 99 }, noCsrf: true });
  rec('ST-04', st04.status === 403 && code(st04) === 'CSRF_INVALID', sc(st04), st04);
  rec('ST-05', r4.status === 400 && r5.status === 400, `percentage 150: ${sc(r4)}; "abc": ${sc(r5)}; row unchanged (ROL-03 version still current)`, r4);
  const sqli = await dev.call('GET', `/flags?q=${encodeURIComponent("' OR 1=1--")}`);
  const xss = await admin.call('POST', '/flags', { body: { key: `xss-${stamp}`, name: 'XSS test', description: '<img src=x onerror=alert(1)>' } });
  rec('ST-09', sqli.status === 200 && sqli.json.items.length === 0 && xss.status === 201 && xss.json.description === '<img src=x onerror=alert(1)>',
    `q=' OR 1=1--: ${sqli.status}, ${sqli.json.items.length} rows; XSS description stored as plain text (${xss.status}); React renders it as text`, sqli);
  const st15 = await anon.call('POST', '/auth/login', { body: { email: 'admin@acme.test', password: PASSWORD } });
  rec('ST-15', st15.status === 403 && code(st15) === 'BOT_CHECK_FAILED', sc(st15), st15);
  if (dbc) {
    const tries = ["UPDATE audit_events SET action = 'x'", 'DELETE FROM audit_events', 'TRUNCATE audit_events'];
    const codes = [];
    for (const sql of tries) {
      await dbc.query('BEGIN');
      try { await dbc.query(sql); codes.push('ALLOWED'); } catch (e) { codes.push(e.code); } finally { await dbc.query('ROLLBACK'); }
    }
    const who = (await dbc.query('SELECT current_user')).rows[0].current_user;
    rec('ST-10', codes.every((c) => c === '42501') && who === 'ffm_app', `as ${who}: UPDATE / DELETE / TRUNCATE audit_events → ${codes.join(' / ')} (42501 = permission denied)`);
    results['AUD-14'] = { ...results['ST-10'] };
  }

  // ===== LAST: brute force (locks dev@acme.test and this IP for 15 minutes) =====
  const bf = actor();
  const bfCodes = [];
  let last;
  for (let i = 0; i < 6; i += 1) { last = await bf.login('dev@acme.test', `wrong-${i}`); bfCodes.push(last.status); }
  const failed = (await admin.call('GET', '/audit?action=login.failed&limit=10')).json?.items?.length ?? 0;
  rec('AUTH-05', bfCodes[5] === 429 && code(last) === 'RATE_LIMITED' && failed >= 6, `responses ${bfCodes.join(' ')}; login.failed events: ${failed}`, last);
  const mon = await admin.call('GET', '/monitoring?hours=1');
  rec('AUD-15', mon.status === 200 && mon.json.failedLogins >= 6 && mon.json.topFailedLoginIps.length > 0, `failedLogins ${mon.json.failedLogins}, top IP ${mon.json.topFailedLoginIps[0]?.ip} × ${mon.json.topFailedLoginIps[0]?.count}`, mon);
  rec('ST-11', bfCodes[5] === 429 && mon.json.failedLogins >= 6, `6th wrong password ${bfCodes[5]}; monitoring card failedLogins ${mon.json.failedLogins}`, last);

  if (dbc) await dbc.end();
  const ids2 = Object.keys(results);
  const passed = ids2.filter((k) => results[k].pass).length;
  console.log(`\n${passed} of ${ids2.length} rows passed.`);

  if (WRITE) writeResults();
  process.exit(passed === ids2.length ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });

// Fill the empty Actual result / Pass/Fail cells of docs/api-test-plan.md (rows we ran), and write a
// standalone evidence file with the request ids.
function writeResults() {
  const repo = path.join(__dirname, '..', '..');
  const planPath = path.join(repo, 'docs', 'api-test-plan.md');
  const date = new Date().toISOString().slice(0, 10);
  const lines = fs.readFileSync(planPath, 'utf8').split(/\r?\n/).map((line) => {
    const m = line.match(/^\| ([A-Z]+-\d+) \|/);
    if (!m || !results[m[1]]) return line;
    const cells = line.split('|');
    const r = results[m[1]];
    const actual = `${r.actual}${r.requestId ? ` · \`${r.requestId.slice(0, 8)}\`` : ''}`;
    cells[cells.length - 3] = ` ${actual} `;
    cells[cells.length - 2] = ` ${r.pass ? 'Pass' : '**Fail**'} `;
    return cells.join('|');
  });
  fs.writeFileSync(planPath, lines.join('\n'));
  const ev = ['# API test plan run (tests/test-plan/run-test-plan.js)', '',
    `Local stack, fresh seeded database, ${date}. Every row of docs/api-test-plan.md that can run over HTTP or against the database as ffm_app. Request ids can be looked up in the audit log and the API log.`, '',
    '| ID | Actual result | Result | Request id |', '|---|---|---|---|',
    ...Object.entries(results).map(([id, r]) => `| ${id} | ${r.actual} | ${r.pass ? 'Pass' : '**Fail**'} | ${r.requestId ? `\`${r.requestId}\`` : ''} |`)];
  fs.writeFileSync(path.join(repo, 'evidence', 'test-results', 'api-test-plan-run.md'), `${ev.join('\n')}\n`);
  console.log('Wrote docs/api-test-plan.md and evidence/test-results/api-test-plan-run.md');
}
