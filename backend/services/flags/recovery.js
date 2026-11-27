const { z } = require('zod');
const { pool } = require('../../db/pool');
const { inTransaction, readFlag } = require('./service');
const snapshots = require('../../shared/snapshots');
const cloud = require('./cloud');
const audit = require('../../shared/audit');
const uuid = z.string().uuid();
const restoreBody = z.object({ versionId: z.string().min(1).max(1024), version: z.number().int().min(1).max(2147483646).nullable() }).strict();
function parseRestore(body) {
  const result = restoreBody.safeParse(body);
  if (!result.success) throw Object.assign(new Error('Provide a versionId and the current flag version (null for a deleted flag).'), { status: 400, code: 'VALIDATION_ERROR' });
  return result.data;
}
function parseQuery(query) {
  const result = z.object({ cursor: z.string().min(1).max(2000).optional() }).strict().safeParse(query);
  if (!result.success) throw Object.assign(new Error('Invalid history query.'), { status: 400, code: 'VALIDATION_ERROR' });
  return result.data;
}
const stale = () => Object.assign(new Error('This flag changed. Reload its details before restoring.'), { status: 409, code: 'STALE_VERSION' });

async function history(req, flagId, cursor) {
  const { rows } = await pool.query('SELECT id FROM flags WHERE id = $1 AND team_id = $2', [flagId, req.user.teamId]);
  if (!snapshots.enabled()) {
    if (!rows.length) throw Object.assign(new Error('Flag not found.'), { status: 404, code: 'NOT_FOUND' });
    return { enabled: false, items: [], nextCursor: null };
  }
  const result = await snapshots.history(req.user.teamId, flagId, cursor);
  if (!rows.length && !result.items.length) throw Object.assign(new Error('Flag not found.'), { status: 404, code: 'NOT_FOUND' });
  return result;
}
async function recoverable(req, cursor) {
  if (!snapshots.enabled()) return { enabled: false, items: [], nextCursor: null };
  const { records, nextCursor } = await snapshots.catalog(req.user.teamId, cursor);
  const ids = records.map(({ data }) => data.flag.id);
  const { rows } = await pool.query('SELECT id FROM flags WHERE team_id = $1 AND id = ANY($2::uuid[])', [req.user.teamId, ids]);
  const existing = new Set(rows.map((row) => row.id));
  return { enabled: true, items: records.filter(({ data }) => !existing.has(data.flag.id)).map(({ versionId, data }) => ({
    flagId: data.flag.id, key: data.flag.key, name: data.flag.name, at: data.at, versionId,
  })), nextCursor };
}
async function restore(req, flagId, { versionId, version }) {
  if (req.user.role !== 'admin') throw Object.assign(new Error('Only an Admin can restore flags.'), { status: 403, code: 'FORBIDDEN' });
  if (!snapshots.enabled()) throw Object.assign(new Error('Flag recovery is available on the AWS deployment.'), { status: 503, code: 'HISTORY_DISABLED' });
  const { data } = await snapshots.read(req.user.teamId, flagId, versionId);
  const source = data.flag;
  const latest = version === null ? (await snapshots.read(req.user.teamId, flagId, null)).data.flag : null;
  try {
    return await inTransaction(async (client) => {
      // Also serialises simultaneous recovery requests for a row that has been deleted.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.user.teamId + ':' + flagId]);
      const { rows: [before] } = await client.query('SELECT id, key, version, archived_at IS NOT NULL AS archived FROM flags WHERE id = $1 AND team_id = $2 FOR UPDATE', [flagId, req.user.teamId]);
      if ((before && before.version !== version) || (!before && version !== null)) throw stale();
      if (before && before.key !== source.key) throw stale();
      const nextVersion = Math.max(before?.version ?? 0, source.version, latest?.version ?? 0) + 1;
      if (nextVersion > 2147483646) throw stale();
      const archived = before ? source.archived : true; // Deleted flags recover safely as archived.
      if (before) {
        await client.query(`UPDATE flags SET name = $3, description = $4, archived_at = CASE WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END,
          version = $6, updated_at = now() WHERE id = $1 AND team_id = $2`, [flagId, req.user.teamId, source.name, source.description, archived, nextVersion]);
      } else {
        await client.query(`INSERT INTO flags (id, team_id, key, name, description, archived_at, created_by, version)
          VALUES ($1, $2, $3, $4, $5, now(), $6, $7)`, [flagId, req.user.teamId, source.key, source.name, source.description, req.user.id, nextVersion]);
      }
      for (const env of ['dev', 'staging', 'prod']) {
        const setting = source.environments[env];
        await client.query(`INSERT INTO flag_environments (flag_id, env, enabled, version) VALUES ($1, $2, $3, $4)
          ON CONFLICT (flag_id, env) DO UPDATE SET enabled = EXCLUDED.enabled,
          version = GREATEST(flag_environments.version + 1, EXCLUDED.version), updated_at = now()`, [flagId, env, setting.enabled, Math.max(nextVersion, setting.version + 1, (latest?.environments[env].version ?? 0) + 1)]);
        await client.query(`INSERT INTO rollouts (flag_id, env, percentage, version) VALUES ($1, $2, $3, $4)
          ON CONFLICT (flag_id, env) DO UPDATE SET percentage = EXCLUDED.percentage, version = GREATEST(rollouts.version + 1, EXCLUDED.version), updated_at = now()`, [flagId, env, setting.percentage, Math.max(setting.rolloutVersion ?? 1, latest?.environments[env].rolloutVersion ?? 1) + 1]);
      }
      await client.query('DELETE FROM user_rules WHERE flag_id = $1', [flagId]);
      for (const rule of data.rules) await client.query('INSERT INTO user_rules (flag_id, env, user_id, kind) VALUES ($1, $2, $3, $4)', [flagId, rule.env, rule.userId, rule.kind]);
      const after = await readFlag(client, req.user.teamId, flagId);
      await audit.record(client, req, { action: 'flag.restored', targetType: 'flag', targetId: flagId,
        details: { env: 'prod', version: source.version }, before: before ? { key: before.key, version: before.version, archived: before.archived } : null,
        after: { key: after.key, name: after.name, version: after.version, archived: after.archived } });
      await cloud.stage(req, client, { flag: after, action: 'flag.restored', env: 'prod' });
      return after;
    });
  } catch (error) {
    if (error.code === '23505') throw Object.assign(new Error('A flag with this key already exists. Recovery cannot overwrite it.'), { status: 409, code: 'CONFLICT' });
    throw error;
  }
}
module.exports = { history, recoverable, restore, parseRestore, parseQuery };
