// Alert rules (S3). shared/audit.js calls raiseFor() right after inserting an audit event, on the
// same client, so a change and the alert it causes are saved together. GitHub delivery happens
// later and outside the transaction (github.js); here an alert only starts as "open".
//
// Rules (one row per team in alert_rules; a missing row counts as enabled, like the column default):
//   prod_change     any change event in the prod environment (details.env === 'prod')
//   key_change      an API key was created or revoked
//   login_failures  LOGIN_FAILURE_THRESHOLD failed logins for the team within LOGIN_FAILURE_WINDOW,
//                   raised at most once per window so an attack opens one alert, not hundreds

const RULES = ['prod_change', 'key_change', 'login_failures'];
const LOGIN_FAILURE_THRESHOLD = 10;
const LOGIN_FAILURE_WINDOW = '15 minutes';

// Which rule (if any) an audit row could trigger. Pure, so it is unit tested without a database.
function candidateRule(row) {
  if (!row.team_id) return null; // events with no known team never raise team alerts
  if (row.category === 'change' && row.details && row.details.env === 'prod') return 'prod_change';
  if (row.action === 'key.created' || row.action === 'key.revoked') return 'key_change';
  if (row.action === 'login.failed') return 'login_failures';
  return null;
}

function titleFor(rule, row) {
  const target = row.target_type ? ` on ${row.target_type} ${row.target_id ?? ''}`.trimEnd() : '';
  if (rule === 'prod_change') return `Prod change: ${row.action}${target} by ${row.actor_label}`;
  if (rule === 'key_change') return `API key change: ${row.action}${target} by ${row.actor_label}`;
  return `Repeated failed logins: ${LOGIN_FAILURE_THRESHOLD}+ in ${LOGIN_FAILURE_WINDOW}`;
}

async function ruleEnabled(db, teamId, rule) {
  const { rows } = await db.query('SELECT enabled FROM alert_rules WHERE team_id = $1 AND rule = $2', [teamId, rule]);
  return rows.length === 0 ? true : rows[0].enabled;
}

async function loginFailuresReached(db, teamId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM audit_events
         WHERE team_id = $1 AND action = 'login.failed' AND at > now() - $2::interval)::int AS failures,
       EXISTS (SELECT 1 FROM alerts
         WHERE team_id = $1 AND rule = 'login_failures' AND created_at > now() - $2::interval) AS already_raised`,
    [teamId, LOGIN_FAILURE_WINDOW],
  );
  return rows[0].failures >= LOGIN_FAILURE_THRESHOLD && !rows[0].already_raised;
}

// Returns the new alert ({ id, rule, title, status }) or null when no rule fires.
async function raiseFor(db, row, auditEventId) {
  const rule = candidateRule(row);
  if (!rule) return null;
  if (!(await ruleEnabled(db, row.team_id, rule))) return null;
  if (rule === 'login_failures' && !(await loginFailuresReached(db, row.team_id))) return null;

  const title = titleFor(rule, row);
  const { rows } = await db.query(
    `INSERT INTO alerts (team_id, audit_event_id, rule, title)
     VALUES ($1, $2, $3, $4)
     RETURNING id, rule, title, status`,
    [row.team_id, auditEventId, rule, title],
  );
  return rows[0];
}

// All three rules for a team, in RULES order, with missing rows shown as enabled.
async function getRules(db, teamId) {
  const { rows } = await db.query('SELECT rule, enabled FROM alert_rules WHERE team_id = $1', [teamId]);
  const stored = new Map(rows.map((r) => [r.rule, r.enabled]));
  return RULES.map((rule) => ({ rule, enabled: stored.get(rule) ?? true }));
}

// Saves the given rules (others keep their value) and audits the change, all on the caller's
// transaction client. Returns { before, after } with every rule in each.
async function updateRules(db, req, changes) {
  const before = await getRules(db, req.user.teamId);
  for (const { rule, enabled } of changes) {
    await db.query(
      `INSERT INTO alert_rules (team_id, rule, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (team_id, rule) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [req.user.teamId, rule, enabled],
    );
  }
  const after = await getRules(db, req.user.teamId);
  // Required here, not at the top: shared/audit.js requires this file.
  await require('../../shared/audit').record(db, req, {
    action: 'alert_rules.updated', targetType: 'alert_rules', targetId: req.user.teamId,
    before: { rules: before }, after: { rules: after },
  });
  return { before, after };
}

module.exports = {
  raiseFor, candidateRule, titleFor, getRules, updateRules,
  RULES, LOGIN_FAILURE_THRESHOLD, LOGIN_FAILURE_WINDOW,
};
