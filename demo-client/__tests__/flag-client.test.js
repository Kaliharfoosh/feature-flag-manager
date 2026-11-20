// Tests for the demo shop's server-side flag check. fetch is replaced by a fake, so no network.
const { checkFlag, handle } = require('../lib/flag-client');

const env = { FFM_API_URL: 'https://ffm.example/', FFM_API_KEY: 'ffm_stg_testkey', FLAG_KEYS: 'new-checkout' };
const answer = (status, body) => jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });

describe('checkFlag', () => {
  test('sends the key as a Bearer header and only flagKey + userId in the body', async () => {
    const fetchImpl = answer(200, { flagKey: 'new-checkout', env: 'staging', enabled: true });
    const result = await checkFlag({ apiUrl: env.FFM_API_URL, apiKey: env.FFM_API_KEY, flagKey: 'new-checkout', userId: 'u-1', fetchImpl });
    expect(result).toEqual({ enabled: true, env: 'staging', source: 'api', note: null });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ffm.example/api/v1/evaluations'); // trailing slash handled
    expect(options.headers.Authorization).toBe('Bearer ffm_stg_testkey');
    expect(JSON.parse(options.body)).toEqual({ flagKey: 'new-checkout', userId: 'u-1' });
  });

  test.each([
    [401, 'UNAUTHENTICATED'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [503, 'DB_UNAVAILABLE'],
  ])('fails closed (enabled false) on %i %s', async (status, code) => {
    const result = await checkFlag({ apiUrl: 'https://ffm.example', apiKey: 'k', flagKey: 'f-1', userId: 'u', fetchImpl: answer(status, { error: { code } }) });
    expect(result).toMatchObject({ enabled: false, source: 'fallback' });
    expect(result.note).toContain(String(status));
  });

  test('fails closed when the network fails', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(await checkFlag({ apiUrl: 'https://x', apiKey: 'k', flagKey: 'f-1', userId: 'u', fetchImpl }))
      .toMatchObject({ enabled: false, source: 'fallback', note: 'Flag service could not be reached.' });
  });

  test('fails closed when the flag service is too slow', async () => {
    const fetchImpl = jest.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    expect(await checkFlag({ apiUrl: 'https://x', apiKey: 'k', flagKey: 'f-1', userId: 'u', fetchImpl, timeoutMs: 20 }))
      .toMatchObject({ enabled: false, note: 'Flag service did not answer in time.' });
  });

  test('only a real true counts as on', async () => {
    const result = await checkFlag({ apiUrl: 'https://x', apiKey: 'k', flagKey: 'f-1', userId: 'u', fetchImpl: answer(200, { enabled: 'yes' }) });
    expect(result.enabled).toBe(false);
  });
});

describe('handle (GET /api/flag)', () => {
  test('200 with the answer', async () => {
    const { status, body } = await handle({ flag: 'new-checkout', user: 'u-981' }, env, answer(200, { env: 'staging', enabled: true }));
    expect(status).toBe(200);
    expect(body).toEqual({ flagKey: 'new-checkout', userId: 'u-981', enabled: true, env: 'staging', source: 'api', note: null });
  });

  test('the key is never in the response', async () => {
    const { body } = await handle({ user: 'u-1' }, env, answer(200, { env: 'staging', enabled: true }));
    expect(JSON.stringify(body)).not.toContain(env.FFM_API_KEY);
  });

  test('400 for a flag not in FLAG_KEYS, so the demo cannot read other flags', async () => {
    const fetchImpl = answer(200, {});
    const { status } = await handle({ flag: 'dark-mode', user: 'u-1' }, env, fetchImpl);
    expect(status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('400 for a missing or too long shopper id', async () => {
    expect((await handle({ user: '' }, env, answer(200, {}))).status).toBe(400);
    expect((await handle({ user: 'x'.repeat(101) }, env, answer(200, {}))).status).toBe(400);
  });

  test('missing configuration still answers, with the classic checkout', async () => {
    const { status, body } = await handle({ user: 'u-1' }, {}, answer(200, {}));
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: false, source: 'fallback' });
  });
});
