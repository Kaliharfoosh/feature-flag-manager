// Creates (or re-passwords) ONE per-service database role and gives it its grants.
// Usage:  npm run db:service-role -- eval        (only ffm-eval-fn has its own role)
//
// What it does, in order:
//   1. Picks a strong random password, or reuses the one already saved in .env.
//   2. Connects as the database owner (DATABASE_URL_MIGRATE) and runs CREATE/ALTER ROLE.
//   3. Applies grants-services.sql, so the role gets ONLY its own table rights.
//   4. Saves FFM_EVAL_PASSWORD and DATABASE_URL_EVAL in .env (ignored by git).
// Nothing secret is ever printed. Safe to run again.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const ROLES = {
  eval: { role: 'ffm_eval_app', passwordVar: 'FFM_EVAL_PASSWORD', urlVar: 'DATABASE_URL_EVAL' },
};

// Write NAME=value into .env: replace the line if it is there, add it at the end if not.
function saveToEnv(envPath, name, value) {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${name}=${value}`, '');
  }
  fs.writeFileSync(envPath, lines.join(eol));
}

async function main() {
  const name = process.argv[2];
  const spec = ROLES[name];
  if (!spec) throw new Error(`Usage: npm run db:service-role -- <${Object.keys(ROLES).join('|')}>`);

  const ownerUrl = process.env.DATABASE_URL_MIGRATE;
  // Same host and database the app already uses (Neon's pooled address), only the login changes.
  const baseUrl = process.env.DATABASE_URL_APP || process.env.DATABASE_URL;
  if (!ownerUrl || !baseUrl) throw new Error('Set DATABASE_URL_MIGRATE and DATABASE_URL in .env first.');

  // Hex only: safe inside the SQL string below and inside a URL, and far above Neon's entropy rule.
  const password = process.env[spec.passwordVar] || crypto.randomBytes(24).toString('hex');
  if (!/^[0-9a-f]{32,}$/.test(password)) throw new Error(`${spec.passwordVar} in .env must be 32+ hex characters.`);

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [spec.role]);
    // Role names and passwords cannot be query parameters in CREATE/ALTER ROLE; both are checked above.
    const verb = rowCount ? 'ALTER' : 'CREATE';
    await client.query(`${verb} ROLE ${spec.role} WITH LOGIN PASSWORD '${password}'`);
    console.log(`${verb === 'CREATE' ? 'created' : 'updated'} role ${spec.role}`);

    await client.query(fs.readFileSync(path.join(__dirname, 'grants-services.sql'), 'utf8'));
    console.log(`grants applied to ${spec.role}`);
  } finally {
    await client.end();
  }

  const url = new URL(baseUrl);
  url.username = spec.role;
  url.password = password;
  const envPath = path.join(__dirname, '..', '..', '.env');
  saveToEnv(envPath, spec.passwordVar, password);
  saveToEnv(envPath, spec.urlVar, url.toString());
  console.log(`saved ${spec.passwordVar} and ${spec.urlVar} in .env (values not shown)`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
