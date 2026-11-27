// S1 FW1 evidence: empty JSON fails validation before password checks, login-attempt rows or alerts.
// Explicit opt-in and a fixed target prevent accidental load tests against another environment.
const fs = require('node:fs');
const path = require('node:path');
const target = 'https://feature-flag-manager-cyan.vercel.app';
if (!process.argv.includes('--live')) { console.log('Run with --live to send 25 empty-body login requests to the public coursework app.'); process.exit(0); }
(async () => {
  const results = [];
  for (let i = 0; i < 25; i++) {
    const response = await fetch(`${target}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(10000) });
    const body = await response.json().catch(() => null);
    results.push({ request: i + 1, status: response.status, code: body?.error?.code ?? null, mitigated: response.headers.get('x-vercel-mitigated') });
  }
  const counts = Object.fromEntries([...new Set(results.map(row => row.status))].map(status => [status, results.filter(row => row.status === status).length]));
  const pass = results.slice(0,20).every(row => row.status === 400 && row.code === 'VALIDATION_ERROR')
    && results.slice(20).every(row => row.status === 429 && row.mitigated === 'deny');
  const evidence = { checkedAt: new Date().toISOString(), test: 'ST-18 / FW1', target, counts, pass, results };
  const output = path.join(__dirname, '../../evidence/test-results/s1-fw1-live.json');
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ test: evidence.test, counts, pass, evidence: 'evidence/test-results/s1-fw1-live.json' }));
  if (!pass) { console.log('Not an exact 20/5 split. Existing traffic may already have used the current window; do not label this as a pass.'); process.exitCode = 1; }
})().catch(error => { console.error('FW1 check did not finish:', error.message); process.exitCode = 1; });
