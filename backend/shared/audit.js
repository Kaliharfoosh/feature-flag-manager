// Audit trail (S3). Every successful write calls record() inside its own transaction, so the
// change and its audit row commit or roll back together. Security events (login.failed,
// access.denied) have no transaction around them and use recordSecurity() instead.
//
// Who did it comes from the request:
//   req.user   = { id, email, role, teamId }    set by requireAuth (S1)
//   req.apiKey = { id, teamId, prefix, env }     set by the API key check (S2)
//   neither    = "anonymous"
//
// Usage in a service:
//   await client.query('BEGIN');
//   ... UPDATE flag_environments ...
//   await audit.record(client, req, {
//     action: 'flag.toggled', targetType: 'flag', targetId: flag.id,
//     before: { enabled: false }, after: { enabled: true },
//   });
//   await client.query('COMMIT');
const { pool } = require('../db/pool');
const alerts = require('../services/audit-alerts/alerts');
const github = require('../services/audit-alerts/github');

const CATEGORIES = ['change', 'security'];
const ACTION_PATTERN = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/; // flag.toggled, alert_rules.updated

// Redaction by allowlist: only these field names keep their value in `details`.
// Anything else (password, password_hash, key_hash, token, a column added next term...)
// is stored as "[REDACTED]", so a new secret can never reach the audit log by accident.
const ALLOWED_DETAIL_KEYS = new Set([
  'before', 'after',
  // flags and environments
  'key', 'name', 'description', 'archived', 'enabled', 'env', 'version',
  // rollouts and user rules
  'percentage', 'userId', 'kind',
  // api keys: the display prefix only, never the key
  'prefix', 'revoked',
  // alert rules
  'rule', 'rules',
  // security events
  'reason', 'method', 'path', 'status', 'requiredRole', 'count', 'rateLimited',
]);

// Belt and braces: a raw API key is redacted wherever it appears, even under an allowed name
// such as `key` (which is normally the flag key).
const API_KEY_PATTERN = /ffm_(dev|stg|prd)_[A-Za-z0-9_-]+/g;
// The display prefix (env code + 6 random characters) is safe and is kept, but only in that exact
// shape: a full key stored under `prefix` by mistake is still redacted.
const PREFIX_PATTERN = /^ffm_(dev|stg|prd)_[A-Za-z0-9]{0,6}$/;

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 4;
const MAX_STRING = 500;
const MAX_ARRAY = 50;

function redactValue(value, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.replace(API_KEY_PATTERN, REDACTED).slice(0, MAX_STRING);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') return redactObject(value, depth + 1);
  return REDACTED; // functions, symbols, bigint
}

function redactObject(obj, depth = 0) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (k === 'prefix') out[k] = typeof v === 'string' && PREFIX_PATTERN.test(v) ? v : REDACTED;
    else out[k] = ALLOWED_DETAIL_KEYS.has(k) ? redactValue(v, depth) : REDACTED;
  }
  return out;
}

function redact(details) {
  if (details === null || details === undefined) return {};
  if (typeof details !== 'object' || Array.isArray(details)) {
    throw new TypeError('audit details must be an object');
  }
  return redactObject(details);
}

function actorFrom(req) {
  if (req && req.user) {
    return { teamId: req.user.teamId ?? null, actorId: req.user.id ?? null, actorLabel: req.user.email };
  }
  if (req && req.apiKey) {
    return { teamId: req.apiKey.teamId ?? null, actorId: null, actorLabel: `api-key:${req.apiKey.prefix}` };
  }
  return { teamId: null, actorId: null, actorLabel: 'anonymous' };
}

// Builds the row without touching the database, so it can be unit tested on its own.
function buildRow(req, event) {
  if (!event || typeof event !== 'object') throw new TypeError('audit event must be an object');
  const category = event.category ?? 'change';
  if (!CATEGORIES.includes(category)) throw new TypeError(`audit category must be one of ${CATEGORIES.join(', ')}`);
  if (typeof event.action !== 'string' || !ACTION_PATTERN.test(event.action)) {
    throw new TypeError('audit action must look like "flag.toggled"');
  }

  const actor = actorFrom(req);
  const details = { ...(event.details ?? {}) };
  if (event.before !== undefined) details.before = event.before;
  if (event.after !== undefined) details.after = event.after;

  return {
    // An explicit teamId is for events where the request has no signed-in user yet
    // (for example login.failed for an email whose team is known).
    team_id: event.teamId !== undefined ? event.teamId : actor.teamId,
    actor_id: actor.actorId,
    actor_label: actor.actorLabel,
    category,
    action: event.action,
    target_type: event.targetType ?? null,
    target_id: event.targetId === undefined || event.targetId === null ? null : String(event.targetId),
    details: redact(details),
    request_id: (req && req.id) ?? null,
    ip: (req && req.ip) ?? null,
  };
}

const INSERT_SQL = `INSERT INTO audit_events
  (team_id, actor_id, actor_label, category, action, target_type, target_id, details, request_id, ip)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING id, at`;

function insert(db, row) {
  return db.query(INSERT_SQL, [
    row.team_id, row.actor_id, row.actor_label, row.category, row.action,
    row.target_type, row.target_id, JSON.stringify(row.details), row.request_id, row.ip,
  ]);
}

// Writes one audit row on the caller's transaction client, plus an alert if a rule matches
// (see services/audit-alerts/alerts.js). Throws if either insert fails, so the caller's
// transaction rolls back: no change is ever saved without its audit row.
// A new alert's id is added to req.pendingAlerts; after COMMIT the caller runs
// `await github.deliverPending(req)` to open its GitHub issue (services/audit-alerts/github.js).
async function record(tx, req, event) {
  if (!tx || typeof tx.query !== 'function') throw new TypeError('record() needs the transaction client');
  const row = buildRow(req, event);
  const { rows } = await insert(tx, row);
  const id = Number(rows[0].id);
  const alert = await alerts.raiseFor(tx, row, id);
  if (alert && req && typeof req === 'object') (req.pendingAlerts ??= []).push(alert.id);
  return { id, at: rows[0].at, alert };
}

// Security events (login.failed, access.denied, rate_limit.hit). Best effort: a logging failure
// is written to the request log but never turns the 401/403/429 the client gets into a 500.
// A bad action name is a programming error, so that one still throws.
async function recordSecurity(req, action, details = {}, { teamId, db = pool } = {}) {
  const row = buildRow(req, { category: 'security', action, details, teamId });
  try {
    const { rows } = await insert(db, row);
    const id = Number(rows[0].id);
    const alert = await alerts.raiseFor(db, row, id);
    // No transaction here, so the alert is already saved: send it now (deliverPending never throws).
    if (alert) await github.deliverPending({ pendingAlerts: [alert.id], log: req && req.log }, { db });
    return { id, at: rows[0].at, alert };
  } catch (err) {
    ((req && req.log) || console).error({ err, action }, 'audit: security event not recorded');
    return null;
  }
}

module.exports = { record, recordSecurity, buildRow, redact, ALLOWED_DETAIL_KEYS, REDACTED };
