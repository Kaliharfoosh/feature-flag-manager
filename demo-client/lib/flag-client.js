// The demo store's only link to the Feature Flag Manager (S2).
// It runs on the SERVER (a Vercel function, or server.js on your PC), never in the browser,
// so the API key stays secret: the browser only ever sees on/off values.
//
// One request per shopper: POST /api/v1/evaluations/batch asks for every store flag at once,
// which counts as ONE request against the key's limit of 120 per minute.
//
// Fail closed: if the Feature Flag Manager is slow, down, rate-limits us or rejects the key,
// every feature is treated as OFF and the shop shows its old behaviour. A flag service problem
// must never break the shop.
const { STORE_FLAGS, STORE_FLAG_KEYS } = require('./store-flags');

const TIMEOUT_MS = 3000;

// Asks POST /api/v1/evaluations/batch. Returns { values, notFound, env, source, note }:
//   values    { flagKey: true/false } (only a real true counts as on)
//   source    'api' when the Feature Flag Manager answered, 'fallback' when it did not
//   note      why it fell back (shown in the store's flag inspector), null otherwise
async function checkFlags({ apiUrl, apiKey, flagKeys, userId, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/api/v1/evaluations/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ userId, flagKeys }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return fallback(`Flag service answered ${response.status}${body?.error?.code ? ` ${body.error.code}` : ''}.`);
    }
    const data = await response.json();
    const flags = data && typeof data.flags === 'object' && data.flags !== null ? data.flags : {};
    const values = Object.fromEntries(flagKeys.map((k) => [k, flags[k] === true]));
    const notFound = Array.isArray(data?.notFound) ? data.notFound.filter((k) => flagKeys.includes(k)) : [];
    return { values, notFound, env: typeof data?.env === 'string' ? data.env : null, source: 'api', note: null };
  } catch (err) {
    return fallback(err.name === 'AbortError' ? 'Flag service did not answer in time.' : 'Flag service could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

function fallback(note) {
  return { values: {}, notFound: [], env: null, source: 'fallback', note };
}

// Handles GET /api/flags?user=u-981 for both Vercel (api/flags.js) and server.js.
// Returns { status, body }. The flag list is fixed in lib/store-flags.js: the browser chooses the
// shopper, never which flags are read.
async function handle(query, env, fetchImpl) {
  const userId = typeof query.user === 'string' ? query.user.trim() : '';
  if (userId.length < 1 || userId.length > 100) {
    return { status: 400, body: { error: 'Enter a shopper id (1 to 100 characters).' } };
  }

  const started = Date.now();
  let result;
  if (!env.FFM_API_URL || !env.FFM_API_KEY) {
    // Misconfigured: still answer, and still fail closed.
    result = fallback('Store is not configured (FFM_API_URL / FFM_API_KEY missing).');
  } else {
    result = await checkFlags({ apiUrl: env.FFM_API_URL, apiKey: env.FFM_API_KEY, flagKeys: STORE_FLAG_KEYS, userId, fetchImpl });
  }

  const flags = STORE_FLAGS.map(({ key, label, area }) => ({
    key,
    label,
    area,
    enabled: result.values[key] === true,
    found: !result.notFound.includes(key),
  }));
  return {
    status: 200,
    body: { userId, env: result.env, source: result.source, note: result.note, ms: Date.now() - started, flags },
  };
}

module.exports = { checkFlags, handle, TIMEOUT_MS };
