// Database reads for POST /evaluations (S2). No HTTP here; controller.js picks the status codes.
// Everything is scoped by the API key's team and environment, never by anything in the body.

// Looks a key up by the SHA-256 of the raw key. Returns { id, teamId, env, prefix, revoked } or null.
async function findKey(db, keyHash) {
  const { rows: [key] } = await db.query(
    `SELECT id, team_id AS "teamId", env, prefix, revoked_at IS NOT NULL AS revoked
     FROM api_keys WHERE key_hash = $1`,
    [keyHash],
  );
  return key ?? null;
}

// Everything evaluate() needs for one flag in one environment, in a single query.
// Returns { archived, enabled, percentage, allow, block } or null when the team has no such flag.
// A missing flag_environments row means off; a missing rollouts row means 0%.
async function loadSetting(db, teamId, env, flagKey) {
  const { rows: [setting] } = await db.query(
    `SELECT f.archived_at IS NOT NULL AS archived,
            COALESCE(fe.enabled, false) AS enabled,
            COALESCE(r.percentage, 0) AS percentage,
            COALESCE(array_agg(ur.user_id) FILTER (WHERE ur.kind = 'allow'), '{}') AS allow,
            COALESCE(array_agg(ur.user_id) FILTER (WHERE ur.kind = 'block'), '{}') AS block
     FROM flags f
     LEFT JOIN flag_environments fe ON fe.flag_id = f.id AND fe.env = $2
     LEFT JOIN rollouts r ON r.flag_id = f.id AND r.env = $2
     LEFT JOIN user_rules ur ON ur.flag_id = f.id AND ur.env = $2
     WHERE f.team_id = $1 AND f.key = $3
     GROUP BY f.id, fe.enabled, r.percentage`,
    [teamId, env, flagKey],
  );
  return setting ?? null;
}

// The same as loadSetting, for many flags of one team and environment in ONE query
// (POST /evaluations/batch). Returns a Map flagKey -> setting; flags the team does not have are
// simply not in the Map.
async function loadSettings(db, teamId, env, flagKeys) {
  const { rows } = await db.query(
    `SELECT f.key,
            f.archived_at IS NOT NULL AS archived,
            COALESCE(fe.enabled, false) AS enabled,
            COALESCE(r.percentage, 0) AS percentage,
            COALESCE(array_agg(ur.user_id) FILTER (WHERE ur.kind = 'allow'), '{}') AS allow,
            COALESCE(array_agg(ur.user_id) FILTER (WHERE ur.kind = 'block'), '{}') AS block
     FROM flags f
     LEFT JOIN flag_environments fe ON fe.flag_id = f.id AND fe.env = $2
     LEFT JOIN rollouts r ON r.flag_id = f.id AND r.env = $2
     LEFT JOIN user_rules ur ON ur.flag_id = f.id AND ur.env = $2
     WHERE f.team_id = $1 AND f.key = ANY($3::text[])
     GROUP BY f.id, f.key, fe.enabled, r.percentage`,
    [teamId, env, flagKeys],
  );
  return new Map(rows.map(({ key, ...setting }) => [key, setting]));
}

// lastUsedAt is updated at most once a minute per key, not on every call, so a busy client app
// does not turn every read into a write (free-tier compute).
async function touchKey(db, keyId) {
  await db.query(
    `UPDATE api_keys SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [keyId],
  );
}

// Per-key rate limit: RATE_LIMIT requests per minute (API contract: 120). Counted in the database
// so every serverless instance shares one count. Fixed one-minute windows.
const DEFAULT_RATE_LIMIT = 120;

// Load tests only (Lab 8): EVAL_RATE_LIMIT raises the limit on your PC, so k6 measures the
// service and not the limiter (all k6 users share one key). It is IGNORED when NODE_ENV is
// production, so a stray setting on Vercel can never weaken the real limit.
function rateLimitFromEnv(env = process.env) {
  if (env.NODE_ENV === 'production' || !env.EVAL_RATE_LIMIT) return DEFAULT_RATE_LIMIT;
  const limit = Number(env.EVAL_RATE_LIMIT);
  return Number.isInteger(limit) && limit >= 1 && limit <= 1000000 ? limit : DEFAULT_RATE_LIMIT;
}
const RATE_LIMIT = rateLimitFromEnv();

// Counts this request and returns { allowed, firstRefusal }.
//   allowed       false once the key has used up this minute
//   firstRefusal  true only for the FIRST refused request in a minute, so the security event is
//                 written once per minute, not once per request (a flood must not flood the log)
// The UPDATE stops at RATE_LIMIT + 1, so a key that keeps hammering causes no more writes.
async function countRequest(db, keyId) {
  const { rows: [row] } = await db.query(
    `INSERT INTO api_key_usage (key_id, window_start) VALUES ($1, date_trunc('minute', now()))
     ON CONFLICT (key_id, window_start)
       DO UPDATE SET count = api_key_usage.count + 1 WHERE api_key_usage.count <= $2
     RETURNING count`,
    [keyId, RATE_LIMIT],
  );
  // The first request of a new minute: tidy up this key's old minutes.
  if (row?.count === 1) {
    await db.query(
      "DELETE FROM api_key_usage WHERE key_id = $1 AND window_start < date_trunc('minute', now())",
      [keyId],
    );
  }
  if (!row) return { allowed: false, firstRefusal: false };      // already over the limit
  if (row.count > RATE_LIMIT) return { allowed: false, firstRefusal: true };
  return { allowed: true, firstRefusal: false };
}

// Seconds until the next minute starts: sent as the Retry-After header with a 429.
function secondsToNextWindow(now = Date.now()) {
  return Math.max(1, Math.ceil((60000 - (now % 60000)) / 1000));
}

module.exports = {
  findKey, loadSetting, loadSettings, touchKey, countRequest, secondsToNextWindow, rateLimitFromEnv, RATE_LIMIT,
};
