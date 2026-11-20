// Creates ONE API key for a seeded team and prints the raw key ONCE. Only its SHA-256 hash is
// stored, so if you lose the printed key, just run this again and use the new one.
// Usage:  npm run seed:key                      (staging key for "Acme Web")
//         npm run seed:key -- dev "Acme Web"    (env, team name)
// Until S1's /keys page exists, this is how the demo client and Postman get a key.
const { Client } = require('pg');
const { newKey } = require('../shared/api-keys');

async function seedKey(connectionString, { env = 'staging', teamName = 'Acme Web', name } = {}) {
  const key = newKey(env); // throws for an env that is not dev, staging or prod
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows: [team] } = await client.query('SELECT id FROM teams WHERE name = $1', [teamName]);
    if (!team) throw new Error(`Team "${teamName}" not found. Run "npm run seed" first.`);
    const { rows: [admin] } = await client.query(
      "SELECT id FROM users WHERE team_id = $1 AND role = 'admin' ORDER BY created_at LIMIT 1", [team.id],
    );
    await client.query(
      'INSERT INTO api_keys (team_id, env, name, prefix, key_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [team.id, env, name ?? `Demo ${env} key`, key.prefix, key.keyHash, admin?.id ?? null],
    );
    return key;
  } finally {
    await client.end();
  }
}

module.exports = { seedKey };

if (require.main === module) {
  const [env = 'staging', teamName = 'Acme Web'] = process.argv.slice(2);
  const url = process.env.DATABASE_URL_MIGRATE || process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL in .env first.'); process.exit(1); }
  seedKey(url, { env, teamName }).then(
    (key) => {
      console.log(`Created a ${env} key for "${teamName}" (prefix ${key.prefix}).`);
      console.log('Copy it now. It is shown only this once and never saved anywhere:');
      console.log(key.raw);
    },
    (err) => { console.error(err.message); process.exit(1); },
  );
}
