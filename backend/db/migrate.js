// Applies every .sql file in ./migrations once, in name order, then re-applies grants.sql.
// Usage: npm run migrate   (uses DATABASE_URL_MIGRATE, falling back to DATABASE_URL)
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function migrate(connectionString, { quiet = false } = {}) {
  const say = (msg) => { if (!quiet) console.log(msg); };
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        say(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${err.message}`);
      }
    }
    await client.query(fs.readFileSync(path.join(__dirname, 'grants.sql'), 'utf8'));
    say('grants applied (if the ffm_app role exists)');
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const url = process.env.DATABASE_URL_MIGRATE || process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL_MIGRATE or DATABASE_URL in .env first.');
    process.exit(1);
  }
  migrate(url).then(
    () => console.log('database is up to date'),
    (err) => { console.error(err.message); process.exit(1); },
  );
}
