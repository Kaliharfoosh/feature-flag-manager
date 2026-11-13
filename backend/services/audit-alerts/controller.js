// HTTP layer for Audit and Monitoring (S3): validate with schema.js, call query.js / alerts.js,
// pick the status code. The team always comes from the session (req.user.teamId), never the client.
const { pool } = require('../../db/pool');
const schema = require('./schema');
const query = require('./query');
const alerts = require('./alerts');
const csv = require('./csv');
const github = require('./github');
const audit = require('../../shared/audit');

async function listAudit(req, res) {
  const filters = schema.parseAuditList(req.query);
  res.json(await query.listEvents(req.user.teamId, filters));
}

async function auditSummary(req, res) {
  const { days } = schema.parseSummary(req.query);
  res.json(await query.summary(req.user.teamId, days));
}

async function exportAudit(req, res) {
  const filters = schema.parseAuditExport(req.query);
  const events = await query.exportEvents(req.user.teamId, filters);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${csv.filename(filters)}"`);
  res.send(csv.toCsv(events));
}

async function monitoring(req, res) {
  const { hours } = schema.parseMonitoring(req.query);
  res.json(await query.monitoring(req.user.teamId, hours));
}

async function getAlertRules(req, res) {
  res.json({ rules: await alerts.getRules(pool, req.user.teamId) });
}

// The rule change and its alert_rules.updated audit row commit together or not at all.
async function putAlertRules(req, res) {
  const { rules } = schema.parseAlertRules(req.body);
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const { after } = await alerts.updateRules(client, req, rules);
    await client.query('COMMIT');
    res.json({ rules: after });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (failure) { releaseError = failure; }
    throw err;
  } finally {
    client.release(releaseError);
  }
}

async function listAlerts(req, res) {
  res.json({ items: await github.listAlerts(req.user.teamId) });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409, code: 'CONFLICT' });
}

// Creates the GitHub issue for the alert raised by one audit event, or retries a failed one.
// 201 when an issue was created now, 200 when it already existed, 502 when GitHub failed
// (the alert stays "failed" with lastError, ready for another retry).
async function createGithubIssue(req, res) {
  const auditId = schema.parseAuditId(req.params.auditId);
  const alert = await github.findAlertForEvent(req.user.teamId, auditId);
  if (!alert) throw Object.assign(new Error('No alert for that audit event.'), { status: 404, code: 'NOT_FOUND' });
  if (alert.status === 'sent') return res.status(200).json(github.toApi(alert));

  let sent;
  let failure;
  try {
    sent = await github.deliver(alert.id);
  } catch (err) {
    failure = err;
  }
  // The request is an Admin write, so it is audited whatever GitHub answered.
  await audit.record(pool, req, {
    action: 'alert.issue_requested', targetType: 'alert', targetId: alert.id,
    details: { rule: alert.rule, status: failure ? 'failed' : (sent ? 'sent' : 'sending') },
  });
  if (failure) throw failure;
  if (!sent) throw conflict('This alert is being sent right now. Reload in a moment.');
  res.status(201).json(github.toApi(sent));
}

module.exports = {
  listAudit, auditSummary, exportAudit, monitoring, getAlertRules, putAlertRules,
  listAlerts, createGithubIssue,
};
