// API key helpers, shared by two services:
//   newKey(env)  -> S1's /keys routes (create a key; the raw key is shown ONCE)
//   hashKey(raw) -> S2's /evaluations (look the key up by its hash)
// Only the SHA-256 hash is stored in api_keys.key_hash, never the raw key.
const crypto = require('node:crypto');

// Same length for every env, so the display prefix is always "ffm_xxx_" + 6 random characters.
// shared/audit.js redacts anything that looks like ffm_(dev|stg|prd)_..., so keep these codes.
const ENV_CODE = Object.freeze({ dev: 'dev', staging: 'stg', prod: 'prd' });
const PREFIX_LENGTH = 14; // "ffm_stg_" (8) + 6 random characters

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function newKey(env) {
  const code = ENV_CODE[env];
  if (!code) throw new TypeError('newKey() needs env: dev, staging or prod');
  // base64url has no "+" or "/", so the key is safe in a header. Retry the rare key whose
  // first 6 random characters contain "-" or "_" so the prefix stays letters and digits only.
  let raw;
  do {
    raw = `ffm_${code}_${crypto.randomBytes(24).toString('base64url')}`;
  } while (!/^[A-Za-z0-9]{6}$/.test(raw.slice(8, PREFIX_LENGTH)));
  return { raw, prefix: raw.slice(0, PREFIX_LENGTH), keyHash: hashKey(raw) };
}

// Reads "Authorization: Bearer <key>". Returns the raw key, or null when it is missing or
// does not look like one of our keys (so we never hash and look up random junk).
const KEY_SHAPE = /^ffm_(dev|stg|prd)_[A-Za-z0-9_-]{20,100}$/;
function readBearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match || !KEY_SHAPE.test(match[1])) return null;
  return match[1];
}

module.exports = { ENV_CODE, PREFIX_LENGTH, newKey, hashKey, readBearer };
