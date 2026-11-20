// Allow / block list data (S2). No HTTP here: controller.js picks the status codes.
// A rule names one end user (the client app's own user id) for one flag in one environment:
//   allow -> always gets the flag (when the environment is on)
//   block -> never gets the flag
// Writes run on the caller's transaction client, so the rule and its audit row commit together.
const audit = require('../../shared/audit');
const { createDefaults } = require('./rollouts');

const RULE_FIELDS = 'id, user_id AS "userId", kind, created_at AS "createdAt"';

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// Returns the flag ({ id, key }) when it belongs to the team, otherwise throws 404.
async function ownFlag(db, teamId, flagId) {
  const { rows: [flag] } = await db.query(
    'SELECT id, key FROM flags WHERE id = $1 AND team_id = $2', [flagId, teamId],
  );
  if (!flag) throw httpError(404, 'NOT_FOUND', 'Flag not found.');
  return flag;
}

// GET /rollouts/:flagId/:env/rules
async function listRules(db, teamId, flagId, env) {
  await ownFlag(db, teamId, flagId);
  const { rows } = await db.query(
    `SELECT ${RULE_FIELDS} FROM user_rules WHERE flag_id = $1 AND env = $2 ORDER BY created_at, user_id`,
    [flagId, env],
  );
  return rows;
}

// POST /rollouts/:flagId/:env/rules. 409 CONFLICT when that user already has a rule here.
async function addRule(tx, req, { teamId, flagId, env, userId, kind }) {
  const flag = await ownFlag(tx, teamId, flagId);
  await createDefaults(tx, flagId); // user_rules points at flag_environments; make sure the row exists

  // ON CONFLICT DO NOTHING instead of catching the unique error: an error would abort the
  // transaction, and "no row returned" is a clear 409.
  const { rows: [rule] } = await tx.query(
    `INSERT INTO user_rules (flag_id, env, user_id, kind) VALUES ($1, $2, $3, $4)
     ON CONFLICT (flag_id, env, user_id) DO NOTHING
     RETURNING ${RULE_FIELDS}`,
    [flagId, env, userId, kind],
  );
  if (!rule) {
    throw httpError(409, 'CONFLICT', 'That user already has a rule for this flag and environment. Delete it first.');
  }

  await audit.record(tx, req, {
    action: 'rule.added',
    targetType: 'rule',
    targetId: rule.id,
    details: { key: flag.key, env, userId, kind },
  });
  return rule;
}

// Finds a rule of the team for DELETE /rules/:ruleId: { id, env, userId, kind, flagKey } or null.
// The controller needs the env first, to apply the prod rule before anything is deleted.
async function findRule(db, teamId, ruleId) {
  const { rows: [rule] } = await db.query(
    `SELECT ur.id, ur.env, ur.user_id AS "userId", ur.kind, f.key AS "flagKey"
     FROM user_rules ur JOIN flags f ON f.id = ur.flag_id
     WHERE ur.id = $1 AND f.team_id = $2`,
    [ruleId, teamId],
  );
  return rule ?? null;
}

// DELETE /rules/:ruleId. Returns false when the rule was already gone (deleted by someone else).
async function removeRule(tx, req, rule) {
  const { rowCount } = await tx.query('DELETE FROM user_rules WHERE id = $1', [rule.id]);
  if (rowCount === 0) return false;
  await audit.record(tx, req, {
    action: 'rule.removed',
    targetType: 'rule',
    targetId: rule.id,
    details: { key: rule.flagKey, env: rule.env, userId: rule.userId, kind: rule.kind },
  });
  return true;
}

module.exports = { listRules, addRule, findRule, removeRule };
