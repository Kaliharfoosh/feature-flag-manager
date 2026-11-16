// Rollout data (S2). No HTTP here: routes and controllers call these functions.
//
// createDefaults(tx, flagId) is called by S1's create-flag service, inside the SAME transaction
// that inserts the flag. It gives the new flag one row per environment in flag_environments
// (off) and in rollouts (0%, version 1). Because the rollout rows always exist, PUT /rollouts can
// use "UPDATE ... WHERE version = $n" and "0 rows updated" can only mean a stale version (409),
// never a missing row.

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

module.exports = { ENVS, createDefaults };
