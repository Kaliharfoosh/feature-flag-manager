const snapshots = require('../../shared/snapshots');
const events = require('../../shared/events');

// Capture inside the transaction; send outside it, after COMMIT. This preserves the exact
// configuration being changed and avoids holding database locks while waiting for AWS.
async function stage(req, client, { flag, action, env = 'all' }) {
  let snapshot;
  if (snapshots.enabled()) {
    const { rows: rules } = await client.query('SELECT env, user_id AS "userId", kind FROM user_rules WHERE flag_id = $1 ORDER BY env, user_id', [flag.id]);
    const { rows: rollouts } = await client.query('SELECT env, version FROM rollouts WHERE flag_id = $1', [flag.id]);
    const versions = new Map(rollouts.map(row => [row.env, row.version]));
    const completeFlag = { ...flag, environments: Object.fromEntries(Object.entries(flag.environments).map(([env, setting]) => [env, { ...setting, rolloutVersion: versions.get(env) ?? 1 }])) };
    snapshot = snapshots.snapshotSchema.parse({ format: 1, teamId: req.user.teamId, at: new Date().toISOString(), action,
      actor: { id: req.user.id, email: req.user.email }, flag: completeFlag, rules });
  }
  (req.s1Changes ??= []).push({ snapshot, action, targetId: flag.id, env });
}
async function flush(req) {
  const changes = req.s1Changes ?? [];
  delete req.s1Changes;
  for (const change of changes) {
    if (change.snapshot) {
      try { await snapshots.save(change.snapshot); }
      catch { (req.log || console).warn({ action: 'snapshot.failed', flagId: change.targetId, requestId: req.id }, 'S1 snapshot failed after commit'); }
    }
    await events.publish(req, change);
  }
}
module.exports = { stage, flush, snapshotsEnabled: snapshots.enabled };
