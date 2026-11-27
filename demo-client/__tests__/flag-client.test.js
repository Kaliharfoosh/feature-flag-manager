// Tests for the demo store's server-side flag check. fetch is replaced by a fake, so no network.
const { checkFlags, handle } = require('../lib/flag-client');
const { STORE_FLAGS, STORE_FLAG_KEYS } = require('../lib/store-flags');

const env = { FFM_API_URL: 'https://ffm.example/', FFM_API_KEY: 'ffm_stg_testkey' };
const answer = (status, body) => jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
const args = (fetchImpl, extra = {}) => ({ apiUrl: 'https://ffm.example', apiKey: 'k', flagKeys: ['gift-wrap', 'apple-pay'], userId: 'u', fetchImpl, ...extra });

describe('store flag list', () => {
  test('keys are valid flag keys, unique, and fit in one batch (max 50)', () => {
    expect(new Set(STORE_FLAG_KEYS).size).toBe(STORE_FLAG_KEYS.length);
    expect(STORE_FLAG_KEYS.length).toBeLessThanOrEqual(50);
    for (const key of STORE_FLAG_KEYS) expect(key).toMatch(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/);
    for (const f of STORE_FLAGS) expect(f.label && f.area).toBeTruthy();
  });

  test('the spare demo keys are in the store list but NOT seeded, so they can be created live', () => {
    const fs = require('fs');
    const path = require('path');
    const seedDir = path.join(__dirname, '..', '..', 'backend', 'db');
    const seeds = ['seed.js', 'seed-demo.js'].map((f) => fs.readFileSync(path.join(seedDir, f), 'utf8')).join('\n');
    for (const key of ['free-shipping-banner', 'free-shipping-banner-2']) {
      expect(STORE_FLAG_KEYS).toContain(key);
      expect(seeds).not.toContain(`'${key}'`);
    }
  });
});

describe('checkFlags', () => {
  test('one batch request: the key as a Bearer header, only userId + flagKeys in the body', async () => {
    const fetchImpl = answer(200, { env: 'staging', flags: { 'gift-wrap': true, 'apple-pay': false }, notFound: [] });
    const result = await checkFlags({ ...args(fetchImpl), apiUrl: env.FFM_API_URL, apiKey: env.FFM_API_KEY });
    expect(result).toEqual({ values: { 'gift-wrap': true, 'apple-pay': false }, notFound: [], env: 'staging', source: 'api', note: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ffm.example/api/v1/evaluations/batch'); // trailing slash handled
    expect(options.headers.Authorization).toBe('Bearer ffm_stg_testkey');
    expect(JSON.parse(options.body)).toEqual({ userId: 'u', flagKeys: ['gift-wrap', 'apple-pay'] });
  });

  test.each([
    [401, 'UNAUTHENTICATED'], [400, 'VALIDATION_ERROR'], [429, 'RATE_LIMITED'], [503, 'DB_UNAVAILABLE'],
  ])('fails closed (everything off) on %i %s', async (status, code) => {
    const result = await checkFlags(args(answer(status, { error: { code } })));
    expect(result).toMatchObject({ values: {}, source: 'fallback' });
    expect(result.note).toContain(String(status));
  });

  test('fails closed when the network fails', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(await checkFlags(args(fetchImpl))).toMatchObject({ values: {}, source: 'fallback', note: 'Flag service could not be reached.' });
  });

  test('fails closed when the flag service is too slow', async () => {
    const fetchImpl = jest.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    expect(await checkFlags(args(fetchImpl, { timeoutMs: 20 }))).toMatchObject({ source: 'fallback', note: 'Flag service did not answer in time.' });
  });

  test('only a real true counts as on; a missing or odd answer is off', async () => {
    const result = await checkFlags(args(answer(200, { env: 'staging', flags: { 'gift-wrap': 'yes' } })));
    expect(result.values).toEqual({ 'gift-wrap': false, 'apple-pay': false });
    const empty = await checkFlags(args(answer(200, null)));
    expect(empty.values).toEqual({ 'gift-wrap': false, 'apple-pay': false });
  });

  test('notFound only keeps keys the store asked for', async () => {
    const result = await checkFlags(args(answer(200, { env: 'staging', flags: {}, notFound: ['apple-pay', 'something-else'] })));
    expect(result.notFound).toEqual(['apple-pay']);
  });
});

describe('handle (GET /api/flags)', () => {
  test('200 with every store flag, on or off, from ONE request', async () => {
    const fetchImpl = answer(200, { env: 'staging', flags: { 'gift-wrap': true, 'new-checkout': true }, notFound: ['dark-mode'] });
    const { status, body } = await handle({ user: ' u-981 ' }, env, fetchImpl);
    expect(status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).flagKeys).toEqual(STORE_FLAG_KEYS);
    expect(body).toMatchObject({ userId: 'u-981', env: 'staging', source: 'api', note: null });
    expect(body.flags).toHaveLength(STORE_FLAGS.length);
    expect(body.flags.find((f) => f.key === 'gift-wrap')).toEqual({ key: 'gift-wrap', label: 'Gift wrapping', area: 'Basket', enabled: true, found: true });
    expect(body.flags.find((f) => f.key === 'apple-pay').enabled).toBe(false);
    expect(body.flags.find((f) => f.key === 'dark-mode').found).toBe(false);
  });

  test('the browser cannot choose which flags are read', async () => {
    const fetchImpl = answer(200, { env: 'staging', flags: {}, notFound: [] });
    await handle({ user: 'u-1', flag: 'secret-team-flag', flagKeys: 'secret-team-flag' }, env, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).flagKeys).toEqual(STORE_FLAG_KEYS);
  });

  test('the key is never in the response', async () => {
    const { body } = await handle({ user: 'u-1' }, env, answer(200, { env: 'staging', flags: {} }));
    expect(JSON.stringify(body)).not.toContain(env.FFM_API_KEY);
  });

  test('400 for a missing or too long shopper id, without asking the flag service', async () => {
    const fetchImpl = answer(200, {});
    expect((await handle({ user: '' }, env, fetchImpl)).status).toBe(400);
    expect((await handle({}, env, fetchImpl)).status).toBe(400);
    expect((await handle({ user: 'x'.repeat(101) }, env, fetchImpl)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('missing configuration still answers, with every feature off', async () => {
    const { status, body } = await handle({ user: 'u-1' }, {}, answer(200, {}));
    expect(status).toBe(200);
    expect(body.source).toBe('fallback');
    expect(body.flags.every((f) => f.enabled === false)).toBe(true);
  });
});
