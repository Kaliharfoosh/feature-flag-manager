const { isIP } = require('node:net');
const { pool } = require('../db/pool');
const audit = require('../shared/audit');

const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET_KEY = '1x0000000000000000000000000000000AA';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function unavailable() {
  return Object.assign(new Error('The sign-in verification service is unavailable. Please try again later.'), {
    status: 503, code: 'BOT_CHECK_UNAVAILABLE',
  });
}

function configuration() {
  const development = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' || process.env.VERCEL_ENV === 'preview';
  const siteKey = process.env.TURNSTILE_SITE_KEY || (development ? TEST_SITE_KEY : '');
  const secretKey = process.env.TURNSTILE_SECRET_KEY || (development ? TEST_SECRET_KEY : '');
  const testSite = /^[123]x0+/.test(siteKey);
  const testSecret = /^[123]x0+/.test(secretKey);
  // Real keys must be configured as a pair. Production never falls back to a test key.
  if (!siteKey || !secretKey || testSite !== testSecret || (!development && testSecret)) throw unavailable();
  const hostnames = (process.env.TURNSTILE_HOSTNAMES || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return { siteKey, secretKey, testMode: testSecret, hostnames };
}

function getClientConfig() {
  return { siteKey: configuration().siteKey, action: 'login' };
}

async function recordFailure(req, email, reason) {
  let teamId = null;
  try {
    const { rows: [account] } = await pool.query(
      'SELECT team_id AS "teamId" FROM users WHERE lower(email) = $1', [email],
    );
    teamId = account?.teamId ?? null;
  } catch {
    // Still record an unscoped event if the team lookup is unavailable.
  }
  await audit.recordSecurity(req, 'bot_check.failed', { reason }, { teamId });
}

async function verifyTurnstile(req, email) {
  const config = configuration();
  const token = req.get('X-Turnstile-Token');
  if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
    await recordFailure(req, email, 'missing_or_invalid_token');
    throw Object.assign(new Error('Complete the sign-in verification and try again.'), { status: 403, code: 'BOT_CHECK_FAILED' });
  }

  let result;
  try {
    const payload = { secret: config.secretKey, response: token };
    if (isIP(req.ip ?? '')) payload.remoteip = req.ip;
    const response = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw unavailable();
    result = await response.json();
    if (typeof result?.success !== 'boolean' || (result['error-codes'] !== undefined && !Array.isArray(result['error-codes']))) throw unavailable();
  } catch {
    await recordFailure(req, email, 'verification_unavailable');
    throw unavailable();
  }

  if (result['error-codes']?.some(code => code === 'invalid-input-secret' || code === 'missing-input-secret' || code === 'internal-error')) {
    await recordFailure(req, email, 'verification_unavailable');
    throw unavailable();
  }
  const validOrigin = config.testMode || (
    result.action === 'login' && typeof result.hostname === 'string' &&
    (!config.hostnames.length || config.hostnames.includes(result.hostname?.toLowerCase()))
  );
  if (!result.success || !validOrigin) {
    await recordFailure(req, email, 'verification_rejected');
    throw Object.assign(new Error('Sign-in verification failed or expired. Please try again.'), { status: 403, code: 'BOT_CHECK_FAILED' });
  }
}

module.exports = { verifyTurnstile, getClientConfig };
