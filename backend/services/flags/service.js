const { pool } = require('../../db/pool');
const { encodeCursor } = require('./schema');
const { createDefaults } = require('../keys-evaluation/rollouts');
const audit = require('../../shared/audit');

const flagDetailsSql = `SELECT f.id, f.key, f.name, f.description, f.archived_at IS NOT NULL AS archived,
       f.version, f.created_by AS "createdBy", f.created_at AS "createdAt", f.updated_at AS "updatedAt",
       settings.environments
FROM flags f
CROSS JOIN LATERAL (
  SELECT jsonb_object_agg(env.name, jsonb_build_object(
    'enabled', COALESCE(fe.enabled, false),
    'percentage', COALESCE(r.percentage, 0),
    'version', COALESCE(fe.version, 1)
  )) AS environments
  FROM (VALUES ('dev'), ('staging'), ('prod')) AS env(name)
  LEFT JOIN flag_environments fe ON fe.flag_id = f.id AND fe.env = env.name
  LEFT JOIN rollouts r ON r.flag_id = fe.flag_id AND r.env = fe.env
) AS settings`;

async function listFlags(teamId, { q, archived, limit, cursor }) {
  // The per-team key is unique and immutable, so it also anchors the next page.
  const { rows } = await pool.query(
    `${flagDetailsSql}
     WHERE f.team_id = $1
       AND (f.archived_at IS NOT NULL) = $2
       AND ($3::text = '' OR strpos(lower(f.key), lower($3)) > 0 OR strpos(lower(f.name), lower($3)) > 0)
       AND ($4::text IS NULL OR f.key > $4)
     ORDER BY f.key
     LIMIT $5`,
    [teamId, archived, q, cursor ?? null, limit + 1],
  );
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items.at(-1).key) : null };
}

async function createFlag(req, input) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const { rows: [flag] } = await client.query(
      `INSERT INTO flags (team_id, key, name, description, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, key, name, description, archived_at IS NOT NULL AS archived,
                 version, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [req.user.teamId, input.key, input.name, input.description, req.user.id],
    );
    const defaults = await createDefaults(client, flag.id);
    const environments = Object.fromEntries(
      Object.entries(defaults).map(([env, setting]) => [env, { enabled: false, ...setting }]),
    );
    await audit.record(client, req, {
      action: 'flag.created',
      targetType: 'flag',
      targetId: flag.id,
      after: { key: flag.key, name: flag.name, description: flag.description, archived: false, version: flag.version },
    });
    await client.query('COMMIT');
    return { ...flag, environments };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (failure) { releaseError = failure; }
    if (error.code === '23505' && error.constraint === 'flags_team_id_key_key') {
      throw Object.assign(new Error('A flag with this key already exists in your team.'), {
        status: 409, code: 'CONFLICT',
      });
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}


async function getFlag(teamId, flagId) {
  const { rows: [flag] } = await pool.query(
    `${flagDetailsSql} WHERE f.id = $1 AND f.team_id = $2`, [flagId, teamId],
  );
  if (!flag) {
    throw Object.assign(new Error('Flag not found.'), { status: 404, code: 'NOT_FOUND' });
  }
  return flag;
}

async function toggleEnvironment(req, { flagId, env, enabled, version }) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const { rows: [flag] } = await client.query(
      'SELECT id, key FROM flags WHERE id = $1 AND team_id = $2 FOR UPDATE',
      [flagId, req.user.teamId],
    );
    if (!flag) {
      throw Object.assign(new Error('Flag not found.'), { status: 404, code: 'NOT_FOUND' });
    }
    if (env === 'prod' && req.user.role !== 'admin') {
      throw Object.assign(new Error('Only an Admin can change production flags.'), { status: 403, code: 'FORBIDDEN' });
    }
    // Older flags can have no row for this environment. Its initial value is Off.
    await client.query(
      'INSERT INTO flag_environments (flag_id, env) VALUES ($1, $2) ON CONFLICT (flag_id, env) DO NOTHING',
      [flagId, env],
    );
    const { rows: [before] } = await client.query(
      'SELECT enabled, version FROM flag_environments WHERE flag_id = $1 AND env = $2 FOR UPDATE',
      [flagId, env],
    );
    if (before.version !== version) {
      throw Object.assign(new Error('This environment changed since you opened it. Reload the details and try again.'), {
        status: 409, code: 'STALE_VERSION',
      });
    }
    const { rows: [after] } = await client.query(
      `UPDATE flag_environments SET enabled = $3, version = version + 1, updated_at = now()
       WHERE flag_id = $1 AND env = $2
       RETURNING enabled, version, updated_at AS "updatedAt"`,
      [flagId, env, enabled],
    );
    await client.query(
      'UPDATE flags SET version = version + 1, updated_at = now() WHERE id = $1', [flagId],
    );
    await audit.record(client, req, {
      action: 'flag.toggled', targetType: 'flag', targetId: flagId,
      details: { key: flag.key, env },
      before: { enabled: before.enabled }, after: { enabled: after.enabled },
    });
    await client.query('COMMIT');
    return { flagId, env, ...after };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (failure) { releaseError = failure; }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

module.exports = { listFlags, createFlag, getFlag, toggleEnvironment };
