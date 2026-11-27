// Seven days of simulated attack traffic for the Monitoring page, on a LOCAL database only.
//
// The live attack demo (s3-attack-demo.js) makes real requests, so everything it causes is
// "now": the 24-hour and 7-day views stay almost empty. This script writes security events with
// timestamps spread over the past week, in the same shape the API writes them, so every window
// has something to show: nightly credential-stuffing waves, lockouts, a Developer probing Admin
// pages, failed bot checks, API-key floods, a few server errors, and attacks with unknown emails
// that belong to no team.
//
// It REFUSES to run against anything but a local database. A real audit log must only ever
// contain real events; simulated rows in Neon would be false evidence.
// Every row it writes has request_id 'sim-…' and details.reason 'simulated', so it can be found
// and removed again.
//
// Usage (repo root):
//   node --env-file=<local env> tests/security/seed-attack-history.js           add 7 days of traffic
//   node --env-file=<local env> tests/security/seed-attack-history.js --remove  delete it again
// Adding needs DATABASE_URL (ffm_app may INSERT into the audit log). Removing needs
// DATABASE_URL_MIGRATE (the owner), because ffm_app may never delete audit rows.
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
const remove = process.argv.includes('--remove');
const url = remove ? process.env.DATABASE_URL_MIGRATE : process.env.DATABASE_URL;
if (!url) { console.error(`${remove ? 'DATABASE_URL_MIGRATE' : 'DATABASE_URL'} is not set.`); process.exit(2); }
const host = new URL(url).hostname;
if (!LOCAL_HOSTS.has(host)) {
  console.error(`Refusing: ${host} is not a local database. Simulated events must never go into a real audit log.`);
  process.exit(2);
}

// A seeded random generator, so every run produces the same week (repeatable screenshots).
let seed = 20261127;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
const pick = (list) => list[Math.floor(rand() * list.length)];
const HOUR = 3600 * 1000;

const STUFFERS = ['203.0.113.24', '203.0.113.77', '198.51.100.13', '192.0.2.201'];
const REFUSED = [
  ['GET', '/api/v1/monitoring'], ['GET', '/api/v1/audit/export.csv'], ['GET', '/api/v1/alerts'],
  ['PUT', '/api/v1/alert-rules'], ['PATCH', '/api/v1/flags/:id/environments/prod'], ['DELETE', '/api/v1/flags/:id'],
  ['POST', '/api/v1/keys'],
];

async function main() {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    if (remove) {
      const { rowCount } = await db.query("DELETE FROM audit_events WHERE request_id LIKE 'sim-%'");
      console.log(`Removed ${rowCount} simulated audit events.`);
      return;
    }

    const teams = Object.fromEntries((await db.query('SELECT id, name FROM teams')).rows.map((t) => [t.name, t.id]));
    const acme = teams['Acme Web'];
    const globex = teams.Globex;
    if (!acme) throw new Error('Team "Acme Web" not found: run the seed first.');
    const devUser = (await db.query("SELECT id, email FROM users WHERE email = 'dev@acme.test'")).rows[0];

    const rows = [];
    const add = (at, teamId, action, details, { ip = null, actor = null } = {}) => rows.push({
      at, teamId, action, ip,
      actorId: actor?.id ?? null,
      actorLabel: actor?.email ?? 'anonymous',
      details: { ...details, reason: details.reason ?? 'simulated' },
    });

    const now = Date.now();
    for (let day = 6; day >= 0; day -= 1) {
      const dayStart = now - day * 24 * HOUR;

      // 1. A credential-stuffing wave most nights (01:00–04:00 UTC-ish): 5 wrong passwords,
      //    then the lockout answers 429 (login.failed with rateLimited true).
      if (day !== 3) {
        const waveStart = dayStart - (20 + Math.floor(rand() * 4)) * HOUR;
        const ip = pick(STUFFERS);
        const size = 8 + Math.floor(rand() * 18);
        for (let i = 0; i < size; i += 1) {
          add(waveStart + i * (20 + rand() * 90) * 1000, acme, 'login.failed', { rateLimited: i >= 5 }, { ip });
        }
      }

      // 2. Unknown emails: belongs to no team (the dashboard's "Not tied to any team" row).
      const unknown = 3 + Math.floor(rand() * 9);
      for (let i = 0; i < unknown; i += 1) {
        add(dayStart - rand() * 24 * HOUR, null, 'login.failed', { rateLimited: false }, { ip: pick(STUFFERS) });
      }

      // 3. Bots without the Turnstile token, some on known accounts, some not.
      const bots = Math.floor(rand() * 5);
      for (let i = 0; i < bots; i += 1) {
        add(dayStart - rand() * 24 * HOUR, rand() < 0.6 ? acme : null, 'bot_check.failed', { reason: 'missing_or_invalid_token' }, { ip: pick(STUFFERS) });
      }

      // 4. A Developer (or a stolen Developer session) probing Admin-only endpoints in office hours.
      if (devUser) {
        const probes = 1 + Math.floor(rand() * 6);
        const at = dayStart - (8 + rand() * 8) * HOUR;
        for (let i = 0; i < probes; i += 1) {
          const [method, path] = pick(REFUSED);
          add(at + i * 40 * 1000, acme, 'access.denied', { method, path, requiredRole: 'admin' }, { ip: '10.0.4.17', actor: devUser });
        }
      }

      // 5. Someone hammers /evaluations with a staging key every other day: the per-key limit.
      if (day % 2 === 0) {
        add(dayStart - rand() * 24 * HOUR, acme, 'rate_limit.hit', { reason: 'api_key', prefix: 'ffm_stg_Ab12', count: 120 }, { ip: '198.51.100.13' });
      }

      // 6. The odd server error, and a little noise for another team (never visible to Acme).
      if (rand() < 0.35) add(dayStart - rand() * 24 * HOUR, acme, 'server.error', { method: 'GET', path: '/api/v1/audit', status: 500 }, { ip: '10.0.4.17' });
      if (globex && rand() < 0.5) add(dayStart - rand() * 24 * HOUR, globex, 'login.failed', { rateLimited: false }, { ip: '192.0.2.9' });
    }

    // Nothing in the future (the newest wave can land a few minutes ahead of "now").
    const kept = rows.filter((r) => r.at <= now - 60 * 1000);
    await db.query('BEGIN');
    for (const r of kept) {
      await db.query(
        `INSERT INTO audit_events (team_id, actor_id, actor_label, category, action, details, request_id, ip, at)
         VALUES ($1, $2, $3, 'security', $4, $5, $6, $7, $8)`,
        [r.teamId, r.actorId, r.actorLabel, r.action, JSON.stringify(r.details), `sim-${randomUUID()}`, r.ip, new Date(r.at)],
      );
    }
    await db.query('COMMIT');

    const count = (f) => kept.filter(f).length;
    console.log(`Added ${kept.length} simulated security events over the last 7 days (local database ${host}).`);
    console.log(`  Acme: failed logins ${count((r) => r.teamId === acme && r.action === 'login.failed')}, refused ${count((r) => r.action === 'access.denied')}, `
      + `bot checks ${count((r) => r.teamId === acme && r.action === 'bot_check.failed')}, API rate limits ${count((r) => r.action === 'rate_limit.hit')}, `
      + `server errors ${count((r) => r.action === 'server.error')}`);
    console.log(`  No team: ${count((r) => r.teamId === null)} · Globex: ${count((r) => r.teamId === globex)}`);
    console.log('Remove them again with --remove.');
  } finally {
    await db.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
