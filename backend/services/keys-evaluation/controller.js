// HTTP layer for the Rollout Service (S2): validate with schema.js, call rollouts.js /
// evaluations.js / evaluate.js, pick the status code. Errors are thrown with .status and .code
// and formatted by middleware/errors.js.
const { pool } = require('../../db/pool');
const schema = require('./schema');
const rollouts = require('./rollouts');
const evaluations = require('./evaluations');
const rules = require('./rules');
const { evaluate } = require('./evaluate');
const { hashKey, readBearer } = require('../../shared/api-keys');
const audit = require('../../shared/audit');
const github = require('../audit-alerts/github');

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// Runs work(client) between BEGIN and COMMIT; any error rolls everything back. After COMMIT,
// alerts raised inside (a prod change) get their GitHub issue opened.
async function inTransaction(req, work) {
  const client = await pool.connect();
  let releaseError;
  let result;
  try {
    await client.query('BEGIN');
    result = await work(client);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (failure) { releaseError = failure; }
    throw err;
  } finally {
    client.release(releaseError);
  }
  await github.deliverPending(req);
  return result;
}

// Prod rule for routes where the env is only known after reading the body or the database
// (POST /preview, DELETE /rules). Same result as requireRole('admin'): 403 + access.denied.
async function adminOnlyForProd(req, env) {
  if (env !== 'prod' || req.user.role === 'admin') return;
  await audit.recordSecurity(req, 'access.denied', {
    method: req.method,
    path: req.originalUrl.split('?')[0],
    requiredRole: 'admin',
  });
  throw httpError(403, 'FORBIDDEN', 'You do not have permission to do this.');
}

// GET /rollouts/:flagId
async function getRollouts(req, res) {
  const flagId = schema.parseFlagId(req.params.flagId);
  const result = await rollouts.getRollouts(pool, req.user.teamId, flagId);
  if (!result) throw httpError(404, 'NOT_FOUND', 'Flag not found.');
  res.json(result);
}

// PUT /rollouts/:flagId/:env  { percentage, version }
// The team comes from the session (req.user.teamId), never from the client.
async function putRollout(req, res) {
  const { flagId, env } = schema.parseRolloutParams(req.params);
  const { percentage, version } = schema.parseRolloutBody(req.body);
  const result = await inTransaction(req, (client) => (
    rollouts.setPercentage(client, req, { teamId: req.user.teamId, flagId, env, percentage, version })
  ));
  res.json(result);
}

// GET /rollouts/:flagId/:env/rules
async function listRules(req, res) {
  const { flagId, env } = schema.parseRolloutParams(req.params);
  res.json({ items: await rules.listRules(pool, req.user.teamId, flagId, env) });
}

// POST /rollouts/:flagId/:env/rules  { userId, kind }
async function addRule(req, res) {
  const { flagId, env } = schema.parseRolloutParams(req.params);
  const { userId, kind } = schema.parseRuleBody(req.body);
  const rule = await inTransaction(req, (client) => (
    rules.addRule(client, req, { teamId: req.user.teamId, flagId, env, userId, kind })
  ));
  res.status(201).json(rule);
}

// DELETE /rules/:ruleId. The rule's env decides the prod rule, so it is read first.
async function deleteRule(req, res) {
  const ruleId = schema.parseRuleId(req.params.ruleId);
  const rule = await rules.findRule(pool, req.user.teamId, ruleId);
  if (!rule) throw httpError(404, 'NOT_FOUND', 'Rule not found.');
  await adminOnlyForProd(req, rule.env);
  const removed = await inTransaction(req, (client) => rules.removeRule(client, req, rule));
  if (!removed) throw httpError(404, 'NOT_FOUND', 'Rule not found.');
  res.status(204).end();
}

// POST /preview  { flagKey, env, userId }: "would this user see the flag?" Reads only.
// Same evaluate() and the same SQL as /evaluations, so the preview can never disagree with it.
async function preview(req, res) {
  const { flagKey, env, userId } = schema.parsePreviewBody(req.body);
  await adminOnlyForProd(req, env);
  const setting = await evaluations.loadSetting(pool, req.user.teamId, env, flagKey);
  if (!setting) throw httpError(404, 'NOT_FOUND', 'Flag not found.');
  const { enabled, reason, bucket } = evaluate(setting, flagKey, userId);
  res.json({ flagKey, env, userId, enabled, reason, bucket });
}

// The part POST /evaluations and POST /evaluations/batch share: API key check, rate limit, then
// load(key, body) reads the flag data. Returns { key, body, data }. No session and no CSRF: a
// client app calls these, not a browser that is signed in. The environment always comes from the
// key. parse() runs after the "is there a key at all" check, so a request with no key is a 401.
async function withApiKey(req, res, parse, load) {
  res.set('Cache-Control', 'no-store');

  const raw = readBearer(req.get('authorization'));
  if (!raw) throw httpError(401, 'UNAUTHENTICATED', 'Send a valid API key as "Authorization: Bearer <key>".');
  const body = parse(req.body);

  let key;
  let data;
  let usage;
  try {
    key = await evaluations.findKey(pool, hashKey(raw));
    if (key && !key.revoked) {
      // Rate limit before the flag is read, so a flood costs as little as possible.
      usage = await evaluations.countRequest(pool, key.id);
      if (usage.allowed) data = await load(key, body);
    }
  } catch (err) {
    // The contract promises 503 here so client apps know to treat the flag as off.
    req.log.error({ err }, 'evaluations: database unavailable');
    audit.recordSecurity(req, 'server.error', { method: req.method, path: req.originalUrl.split('?')[0], status: 503 });
    throw httpError(503, 'DB_UNAVAILABLE', 'Flag service is unavailable. Treat the flag as off.');
  }

  // Unknown and revoked keys get the same answer, so a caller cannot tell which it was.
  if (!key || key.revoked) {
    if (key) {
      req.apiKey = key; // so the audit row shows "api-key:<prefix>"
      await audit.recordSecurity(req, 'access.denied', { reason: 'revoked', prefix: key.prefix });
    }
    throw httpError(401, 'UNAUTHENTICATED', 'The API key is missing, unknown or revoked.');
  }
  req.apiKey = key;

  // 429: more than 120 requests this minute for this key. Logged once per minute as
  // rate_limit.hit, which S3's monitoring card counts as "rate limited".
  if (!usage.allowed) {
    if (usage.firstRefusal) {
      await audit.recordSecurity(req, 'rate_limit.hit', { reason: 'api_key', prefix: key.prefix, count: evaluations.RATE_LIMIT });
    }
    res.set('Retry-After', String(evaluations.secondsToNextWindow()));
    throw httpError(429, 'RATE_LIMITED', `Too many requests for this API key (limit ${evaluations.RATE_LIMIT} per minute).`);
  }

  // Best effort: a failed lastUsedAt update must never change the answer the client gets.
  // Awaited, because Vercel may freeze the function as soon as the response is sent.
  try {
    await evaluations.touchKey(pool, key.id);
  } catch (err) {
    req.log.warn({ err }, 'evaluations: lastUsedAt not updated');
  }
  return { key, body, data };
}

// POST /evaluations  Authorization: Bearer ffm_stg_...  { flagKey, userId }
async function postEvaluation(req, res) {
  const { key, body, data: setting } = await withApiKey(req, res, schema.parseEvaluationBody,
    (k, { flagKey }) => evaluations.loadSetting(pool, k.teamId, k.env, flagKey));

  // Another team's flag and a flag that does not exist look the same: 404.
  if (!setting) throw httpError(404, 'NOT_FOUND', 'Flag not found.');

  const { enabled } = evaluate(setting, body.flagKey, body.userId);
  res.json({ flagKey: body.flagKey, env: key.env, enabled });
}

// POST /evaluations/batch  Authorization: Bearer ffm_stg_...  { userId, flagKeys: [...] }
// Many flags for one user in one request (a client app's page needs ~25 at once). It counts as
// ONE request for the rate limit and reads all the flags in ONE query. Flags the key's team does
// not have are listed in notFound and never come back true, the same as a 404 for one flag.
async function postEvaluationBatch(req, res) {
  const { key, body, data: settings } = await withApiKey(req, res, schema.parseBatchBody,
    (k, { flagKeys }) => evaluations.loadSettings(pool, k.teamId, k.env, flagKeys));

  const flags = {};
  const notFound = [];
  for (const flagKey of body.flagKeys) {
    const setting = settings.get(flagKey);
    if (setting) flags[flagKey] = evaluate(setting, flagKey, body.userId).enabled;
    else notFound.push(flagKey);
  }
  res.json({ env: key.env, flags, notFound });
}

module.exports = {
  getRollouts, putRollout, listRules, addRule, deleteRule, preview, postEvaluation, postEvaluationBatch,
};
