const { pool } = require('../../db/pool');
const { newKey } = require('../../shared/api-keys');
const audit = require('../../shared/audit');

// Explicit fields keep both the hash and the raw secret out of reads and audit details.
const fields = `id, name, env, prefix, created_at AS "createdAt",
                last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

async function listKeys(teamId) {
  const { rows } = await pool.query(
    `SELECT ${fields} FROM api_keys WHERE team_id = $1 ORDER BY created_at DESC, id DESC`, [teamId],
  );
  return { items: rows };
}

async function transaction(work) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (failure) { releaseError = failure; }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function createKey(req, { name, env }) {
  const secret = newKey(env);
  return transaction(async (client) => {
    const { rows: [key] } = await client.query(
      `INSERT INTO api_keys (team_id, env, name, prefix, key_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${fields}`,
      [req.user.teamId, env, name, secret.prefix, secret.keyHash, req.user.id],
    );
    await audit.record(client, req, {
      action: 'key.created', targetType: 'api_key', targetId: key.id,
      after: { name, env, prefix: secret.prefix, revoked: false },
    });
    // This is the only response that includes the raw key; it is never persisted.
    return { ...key, key: secret.raw };
  });
}

async function revokeKey(req, id) {
  return transaction(async (client) => {
    const { rows: [key] } = await client.query(
      `SELECT ${fields} FROM api_keys WHERE id = $1 AND team_id = $2 FOR UPDATE`,
      [id, req.user.teamId],
    );
    if (!key) throw Object.assign(new Error('API key not found.'), { status: 404, code: 'NOT_FOUND' });
    // Repeated requests are safe and do not create duplicate audit records or alerts.
    if (key.revokedAt) return null;
    await client.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND team_id = $2', [id, req.user.teamId]);
    await audit.record(client, req, {
      action: 'key.revoked', targetType: 'api_key', targetId: id,
      before: { name: key.name, env: key.env, prefix: key.prefix, revoked: false },
      after: { name: key.name, env: key.env, prefix: key.prefix, revoked: true },
    });
    return { id: key.id, prefix: key.prefix, env: key.env };
  });
}

module.exports = { listKeys, createKey, revokeKey };

