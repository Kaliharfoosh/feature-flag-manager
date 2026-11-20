const { pool } = require('../../db/pool');
const { encodeCursor } = require('./schema');
const { createDefaults } = require('../keys-evaluation/rollouts');
const audit = require('../../shared/audit');

async function listFlags(teamId, { q, archived, limit, cursor }) {
  // The per-team key is unique and immutable, so it also anchors the next page.
  // Environment toggles start at version 1. Rollouts have their own versions.
  const { rows } = await pool.query(
    `WITH page AS (
       SELECT id, key, name, description, archived_at IS NOT NULL AS archived,
              version, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM flags
       WHERE team_id = $1
         AND (archived_at IS NOT NULL) = $2
         AND ($3::text = '' OR strpos(lower(key), lower($3)) > 0 OR strpos(lower(name), lower($3)) > 0)
         AND ($4::text IS NULL OR key > $4)
       ORDER BY key
       LIMIT $5
     )
     SELECT page.*, settings.environments
     FROM page
     CROSS JOIN LATERAL (
       SELECT jsonb_object_agg(env.name, jsonb_build_object(
         'enabled', COALESCE(fe.enabled, false),
         'percentage', COALESCE(r.percentage, 0),
         'version', 1
       )) AS environments
       FROM (VALUES ('dev'), ('staging'), ('prod')) AS env(name)
       LEFT JOIN flag_environments fe ON fe.flag_id = page.id AND fe.env = env.name
       LEFT JOIN rollouts r ON r.flag_id = fe.flag_id AND r.env = fe.env
     ) AS settings
     ORDER BY page.key`,
    [teamId, archived, q, cursor ?? null, limit + 1],
  );

  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(items.at(-1).key) : null;
  return { items, nextCursor };
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

module.exports = { listFlags, createFlag };
