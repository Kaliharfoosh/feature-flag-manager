// HTTP layer for Audit and Monitoring (S3): validate with schema.js, call query.js / alerts.js,
// pick the status code. The team always comes from the session (req.user.teamId), never the client.
const { pool } = require('../../db/pool');
const schema = require('./schema');
const query = require('./query');
const alerts = require('./alerts');
const csv = require('./csv');

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

module.exports = { listAudit, auditSummary, exportAudit, monitoring, getAlertRules, putAlertRules };
