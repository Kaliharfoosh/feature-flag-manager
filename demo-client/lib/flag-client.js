// The demo shop's only link to the Feature Flag Manager (S2).
// It runs on the SERVER (a Vercel function, or server.js on your PC), never in the browser,
// so the API key stays secret: the browser only ever sees { enabled }.
//
// Fail closed: if the Feature Flag Manager is slow, down, rate-limits us or rejects the key,
// the shop shows the OLD checkout. A flag service problem must never break the shop.

const FLAG_KEY = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const TIMEOUT_MS = 3000;

// Asks POST /api/v1/evaluations. Returns { enabled, env, source, note }:
//   source 'api'      the Feature Flag Manager answered
//   source 'fallback' it did not, so enabled is false (note says why, for the demo panel)
async function checkFlag({ apiUrl, apiKey, flagKey, userId, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/v1/evaluations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ flagKey, userId }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return fallback(`Flag service answered ${response.status}${body?.error?.code ? ` ${body.error.code}` : ''}.`);
    }
    const data = await response.json();
    return { enabled: data.enabled === true, env: data.env, source: 'api', note: null };
  } catch (err) {
    return fallback(err.name === 'AbortError' ? 'Flag service did not answer in time.' : 'Flag service could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

function fallback(note) {
  return { enabled: false, env: null, source: 'fallback', note };
}

// Handles GET /api/flag?flag=new-checkout&user=u-981 for both Vercel and server.js.
// Returns { status, body }. Only flags listed in FLAG_KEYS may be asked for, so the demo can't
// be used to read every flag of the team with our key.
async function handle(query, env, fetchImpl) {
  const allowed = (env.FLAG_KEYS || 'new-checkout').split(',').map((s) => s.trim()).filter(Boolean);
  const flagKey = typeof query.flag === 'string' ? query.flag : allowed[0];
  const userId = typeof query.user === 'string' ? query.user.trim() : '';

  if (!FLAG_KEY.test(flagKey) || !allowed.includes(flagKey)) {
    return { status: 400, body: { error: 'This demo can only ask about: ' + allowed.join(', ') } };
  }
  if (userId.length < 1 || userId.length > 100) {
    return { status: 400, body: { error: 'Enter a shopper id (1 to 100 characters).' } };
  }
  if (!env.FFM_API_URL || !env.FFM_API_KEY) {
    // Misconfigured: still answer, and still fail closed.
    return { status: 200, body: { flagKey, userId, ...fallback('Demo is not configured (FFM_API_URL / FFM_API_KEY missing).') } };
  }

  const result = await checkFlag({ apiUrl: env.FFM_API_URL, apiKey: env.FFM_API_KEY, flagKey, userId, fetchImpl });
  return { status: 200, body: { flagKey, userId, ...result } };
}

module.exports = { checkFlag, handle, TIMEOUT_MS };
