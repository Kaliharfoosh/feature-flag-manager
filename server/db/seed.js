// Creates demo data: two teams (the second one is for ownership tests), three users,
// a few flags and default alert rules. Safe to run twice; it skips existing teams.
// Usage: npm run seed   (needs SEED_PASSWORD in .env)
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const TEAMS = [
  {
    name: 'Acme Web',
    users: [
      { email: 'admin@acme.test', name: 'Amira Admin', role: 'admin' },
      { email: 'dev@acme.test', name: 'Dina Developer', role: 'developer' },
    ],
    flags: [
      {
        key: 'new-checkout', name: 'New checkout flow', description: 'Single-page checkout with saved cards.',
        envs: { dev: [true, 100], staging: [true, 25], prod: [false, 0] },
      },
      {
        key: 'dark-mode', name: 'Dark mode', description: 'Dark colour theme for the storefront.',
        envs: { dev: [true, 100], staging: [false, 0], prod: [false, 0] },
      },
      {
        key: 'search-v2', name: 'Search v2', description: 'Replaced by the search service rewrite.',
        envs: { dev: [false, 0], staging: [false, 0], prod: [false, 0] }, archived: true,
      },
    ],
  },
  {
    name: 'Globex',
    users: [{ email: 'admin@globex.test', name: 'Gary Globex', role: 'admin' }],
    flags: [
      {
        key: 'loyalty-points', name: 'Loyalty points', description: 'Globex-only flag used in ownership tests.',
        envs: { dev: [true, 100], staging: [false, 0], prod: [false, 0] },
      },
    ],
  },
];

async function seed(connectionString, password, { quiet = false } = {}) {
  if (!password || password.length < 12) throw new Error('SEED_PASSWORD must be at least 12 characters.');
  const say = (msg) => { if (!quiet) console.log(msg); };
  const hash = await bcrypt.hash(password, 12);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const team of TEAMS) {
      const existing = await client.query('SELECT id FROM teams WHERE name = $1', [team.name]);
      if (existing.rows[0]) { say(`team "${team.name}" already exists, skipped`); continue; }
      const { rows: [t] } = await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [team.name]);
      let creator = null;
      for (const u of team.users) {
        const { rows: [user] } = await client.query(
          'INSERT INTO users (team_id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [t.id, u.email, u.name, hash, u.role],
        );
        creator = creator || user.id;
      }
      for (const f of team.flags) {
        const { rows: [flag] } = await client.query(
          `INSERT INTO flags (team_id, key, name, description, created_by, archived_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [t.id, f.key, f.name, f.description, creator, f.archived ? new Date() : null],
        );
        for (const [env, [enabled, percentage]] of Object.entries(f.envs)) {
          await client.query('INSERT INTO flag_environments (flag_id, env, enabled) VALUES ($1, $2, $3)', [flag.id, env, enabled]);
          if (percentage > 0) {
            await client.query('INSERT INTO rollouts (flag_id, env, percentage) VALUES ($1, $2, $3)', [flag.id, env, percentage]);
          }
        }
      }
      for (const rule of ['prod_change', 'key_change', 'login_failures']) {
        await client.query('INSERT INTO alert_rules (team_id, rule, enabled) VALUES ($1, $2, true)', [t.id, rule]);
      }
      say(`seeded team "${team.name}"`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

module.exports = { seed };

if (require.main === module) {
  const url = process.env.DATABASE_URL_MIGRATE || process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL in .env first.'); process.exit(1); }
  seed(url, process.env.SEED_PASSWORD).then(
    () => console.log('seed complete. Log in as admin@acme.test or dev@acme.test with SEED_PASSWORD.'),
    (err) => { console.error(err.message); process.exit(1); },
  );
}
