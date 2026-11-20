// HTTP layer for the Rollout Service (S2): validate with schema.js, call rollouts.js /
// evaluations.js / evaluate.js, pick the status code. Errors are thrown with .status and .code
// and formatted by middleware/errors.js.
const { pool } = require('../../db/pool');
const schema = require('./schema');
const rollouts = require('./rollouts');
const evaluations = require('./evaluations');
const { evaluate } = require('./evaluate');
const { hashKey, readBearer } = require('../../shared/api-keys');
const audit = require('../../shared/audit');
const github = require('../audit-alerts/github');

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// PUT /rollouts/:flagId/:env  { percentage, version }
// The team comes from the session (req.user.teamId), never from the client.
async function putRollout(req, res) {
  const { flagId, env } = schema.parseRolloutParams(req.params);
  const { percentage, version } = schema.parseRolloutBody(req.body);

  const client = await pool.connect();
  let releaseError;
  let result;
  try {
    await client.query('BEGIN');
    result = await rollouts.setPercentage(client, req, { teamId: req.user.teamId, flagId, env, percentage, version });
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (failure) { releaseError = failure; }
    throw err;
  } finally {
    client.release(releaseError);
  }

  // A prod change raises an alert inside the transaction; its GitHub issue is opened after COMMIT.
  await github.deliverPending(req);
  res.json(result);
}

// POST /evaluations  Authorization: Bearer ffm_stg_...  { flagKey, userId }
// No session and no CSRF: a client app calls this, not a browser that is signed in.
// The environment always comes from the key.
async function postEvaluation(req, res) {
  res.set('Cache-Control', 'no-store');

  const raw = readBearer(req.get('authorization'));
  if (!raw) throw httpError(401, 'UNAUTHENTICATED', 'Send a valid API key as "Authorization: Bearer <key>".');
  const { flagKey, userId } = schema.parseEvaluationBody(req.body);

  let key;
  let setting;
  let usage;
  try {
    key = await evaluations.findKey(pool, hashKey(raw));
    if (key && !key.revoked) {
      // Rate limit before the flag is read, so a flood costs as little as possible.
      usage = await evaluations.countRequest(pool, key.id);
      if (usage.allowed) setting = await evaluations.loadSetting(pool, key.teamId, key.env, flagKey);
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

  // Another team's flag and a flag that does not exist look the same: 404.
  if (!setting) throw httpError(404, 'NOT_FOUND', 'Flag not found.');

  const { enabled } = evaluate(setting, flagKey, userId);

  // Best effort: a failed lastUsedAt update must never change the answer the client gets.
  // Awaited, because Vercel may freeze the function as soon as the response is sent.
  try {
    await evaluations.touchKey(pool, key.id);
  } catch (err) {
    req.log.warn({ err }, 'evaluations: lastUsedAt not updated');
  }

  res.json({ flagKey, env: key.env, enabled });
}

module.exports = { putRollout, postEvaluation };
