// Rollout data (S2). No HTTP here: routes and controllers call these functions.
//
// createDefaults(tx, flagId) is called by S1's create-flag service, inside the SAME transaction
// that inserts the flag. It gives the new flag one row per environment in flag_environments
// (off) and in rollouts (0%, version 1). Because the rollout rows always exist, PUT /rollouts can
// use "UPDATE ... WHERE version = $n" and "0 rows updated" can only mean a stale version (409),
// never a missing row.

const audit = require('../../shared/audit');

const ENVS = Object.freeze(['dev', 'staging', 'prod']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns { dev: { percentage, version }, staging: {...}, prod: {...} }, the same shape as
// GET /rollouts/:flagId. Safe to call twice: rows that already exist are left as they are,
// so it never resets a rollout someone has already changed.
async function createDefaults(tx, flagId) {
  if (!tx || typeof tx.query !== 'function') throw new TypeError('createDefaults() needs the transaction client');
  if (typeof flagId !== 'string' || !UUID.test(flagId)) throw new TypeError('createDefaults() needs the flag id (a uuid)');

  // rollouts has a foreign key to flag_environments, so those rows must exist first.
  await tx.query(
    `INSERT INTO flag_environments (flag_id, env)
     SELECT $1::uuid, env FROM unnest($2::text[]) AS env
     ON CONFLICT (flag_id, env) DO NOTHING`,
    [flagId, ENVS],
  );
  await tx.query(
    `INSERT INTO rollouts (flag_id, env)
     SELECT $1::uuid, env FROM unnest($2::text[]) AS env
     ON CONFLICT (flag_id, env) DO NOTHING`,
    [flagId, ENVS],
  );
  const { rows } = await tx.query(
    'SELECT env, percentage, version FROM rollouts WHERE flag_id = $1',
    [flagId],
  );

  const result = {};
  for (const env of ENVS) {
    const row = rows.find((r) => r.env === env);
    // pg returns numeric(5,2) as a string such as "0.00"
    result[env] = { percentage: Number(row?.percentage ?? 0), version: row?.version ?? 1 };
  }
  return result;
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// PUT /rollouts/:flagId/:env. Runs on the caller's transaction client (BEGIN/COMMIT are in the
// controller), so the new percentage and its audit row are saved together or not at all.
// Returns { flagId, env, percentage, version, updatedAt }.
//   404 NOT_FOUND      the flag does not exist or belongs to another team (never 403)
//   409 STALE_VERSION  someone changed this rollout since the client read it
async function setPercentage(tx, req, { teamId, flagId, env, percentage, version }) {
  const { rows: [flag] } = await tx.query(
    'SELECT id, key FROM flags WHERE id = $1 AND team_id = $2',
    [flagId, teamId],
  );
  if (!flag) throw httpError(404, 'NOT_FOUND', 'Flag not found.');

  // Flags made before createDefaults existed (for example the seed data) may have no rollout
  // row yet. This adds the missing rows at 0%, version 1, and leaves existing rows alone.
  await createDefaults(tx, flagId);

  // FOR UPDATE locks the row until COMMIT, so two people saving at once cannot both win.
  const { rows: [before] } = await tx.query(
    'SELECT percentage, version FROM rollouts WHERE flag_id = $1 AND env = $2 FOR UPDATE',
    [flagId, env],
  );
  if (before.version !== version) {
    throw httpError(409, 'STALE_VERSION', 'This rollout was changed by someone else. Reload and try again.');
  }

  const { rows: [after] } = await tx.query(
    `UPDATE rollouts SET percentage = $3, version = version + 1, updated_at = now()
     WHERE flag_id = $1 AND env = $2
     RETURNING percentage, version, updated_at AS "updatedAt"`,
    [flagId, env, percentage],
  );

  // details.env = 'prod' is what makes S3's prod_change alert rule fire.
  await audit.record(tx, req, {
    action: 'rollout.updated',
    targetType: 'rollout',
    targetId: `${flagId}/${env}`,
    details: { key: flag.key, env },
    before: { percentage: Number(before.percentage) },
    after: { percentage: Number(after.percentage) },
  });

  return {
    flagId, env,
    percentage: Number(after.percentage),
    version: after.version,
    updatedAt: after.updatedAt,
  };
}

// GET /rollouts/:flagId. Returns { flagId, environments: { dev: { percentage, version }, ... } }
// or null when the team has no such flag. A missing rollout row reads as 0%, version 1: that is
// exactly what PUT /rollouts creates for it, so the version the page sends back will match.
async function getRollouts(db, teamId, flagId) {
  const { rows } = await db.query(
    `SELECT env.name AS env, r.percentage, r.version
     FROM flags f
     CROSS JOIN unnest($3::text[]) AS env(name)
     LEFT JOIN rollouts r ON r.flag_id = f.id AND r.env = env.name
     WHERE f.id = $1 AND f.team_id = $2`,
    [flagId, teamId, ENVS],
  );
  if (rows.length === 0) return null;
  const environments = {};
  for (const env of ENVS) {
    const row = rows.find((r) => r.env === env);
    environments[env] = { percentage: Number(row?.percentage ?? 0), version: row?.version ?? 1 };
  }
  return { flagId, environments };
}

module.exports = { ENVS, createDefaults, setPercentage, getRollouts };
