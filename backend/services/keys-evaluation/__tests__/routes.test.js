// These route tests isolate the sign-in flow from the external challenge service.
jest.mock('../../../middleware/turnstile', () => ({
  ...jest.requireActual('../../../middleware/turnstile'), verifyTurnstile: jest.fn(),
}));

// Route tests for PUT /rollouts and POST /evaluations through the real Express app: real
// sessions, CSRF, requireAuth and requireRole. The database and the login check are mocked;
// rollouts.db.test.js runs the same SQL against a real Postgres.
const request = require('supertest');

jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../../db/pool', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../../auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../../audit-alerts/github', () => ({
  ...jest.requireActual('../../audit-alerts/github'), deliverPending: jest.fn(),
}));

process.env.SESSION_SECRET = 'session-secret-for-rollout-tests';
process.env.LOG_LEVEL = 'silent';

const app = require('../../../app');
const { pool } = require('../../../db/pool');
const authService = require('../../auth/service');
const { newKey } = require('../../../shared/api-keys');

const api = '/api/v1';
const teamId = '699df5c7-e092-4a81-b7cb-14d6ea382378';
const flagId = '3d6e0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const users = {
  admin: { id: 'c72f08c0-3a44-4f92-8379-0375da225f99', email: 'admin@acme.test', name: 'Amira Admin', role: 'admin', teamId },
  developer: { id: 'd1e2f3a4-0000-4000-8000-000000000002', email: 'dev@acme.test', name: 'Dina Developer', role: 'developer', teamId },
};
const tx = { query: jest.fn(), release: jest.fn() };

// A tiny fake database: one flag, its staging rollout and one API key.
let db;
function fakeQuery(sql, params = []) {
  if (sql.startsWith('INSERT INTO audit_events')) return { rows: [{ id: '77', at: new Date() }] };
  if (sql.startsWith('SELECT id, key FROM flags')) {
    return { rows: params[0] === flagId && params[1] === teamId ? [{ id: flagId, key: 'new-checkout' }] : [] };
  }
  if (sql.startsWith('SELECT percentage, version FROM rollouts')) return { rows: [{ ...db.rollout }] };
  if (sql.startsWith('UPDATE rollouts')) {
    db.rollout = { percentage: params[2].toFixed(2), version: db.rollout.version + 1 };
    return { rows: [{ ...db.rollout, updatedAt: new Date('2026-11-20T10:00:00Z') }] };
  }
  if (sql.includes('FROM api_keys WHERE key_hash')) {
    return { rows: db.key && params[0] === db.key.keyHash ? [{ id: 'k1', teamId, env: db.key.env, prefix: db.key.prefix, revoked: db.key.revoked }] : [] };
  }
  if (sql.startsWith('INSERT INTO api_key_usage')) {
    if (db.usage > params[1]) return { rows: [] }; // the real UPDATE stops at limit + 1
    db.usage += 1;
    return { rows: [{ count: db.usage }] };
  }
  if (sql.includes('FROM flags f') && Array.isArray(params[2])) { // loadSettings (batch)
    return { rows: params[2].filter((k) => db.batch[k]).map((k) => ({ key: k, ...db.batch[k] })) };
  }
  if (sql.includes('FROM flags f')) return { rows: params[2] === 'new-checkout' ? [db.setting] : [] };
  return { rows: [] };
}
const auditActions = () => [...pool.query.mock.calls, ...tx.query.mock.calls]
  .filter(([sql]) => sql.startsWith('INSERT INTO audit_events'))
  .map(([, params]) => params[4]);

async function signIn(role) {
  const agent = request.agent(app);
  authService.authenticate.mockResolvedValueOnce({ user: users[role], rateLimited: false });
  await agent.post(`${api}/auth/login`).send({ email: users[role].email, password: 'irrelevant-here' }).expect(200);
  const me = await agent.get(`${api}/auth/me`).expect(200);
  return { agent, csrf: me.body.csrfToken };
}

beforeEach(() => {
  jest.clearAllMocks();
  const key = newKey('staging');
  db = {
    rollout: { percentage: '0.00', version: 3 },
    usage: 0, // requests this key has made this minute
    key: { ...key, env: 'staging', revoked: false },
    setting: { archived: false, enabled: true, percentage: '100.00', allow: [], block: [] },
    // the team's flags for the batch tests
    batch: {
      'new-checkout': { archived: false, enabled: true, percentage: '0.00', allow: ['u-beta-1'], block: [] },
      'gift-wrap': { archived: false, enabled: true, percentage: '100.00', allow: [], block: ['u-fraud-77'] },
      'paypal-v1': { archived: true, enabled: true, percentage: '100.00', allow: [], block: [] },
    },
  };
  authService.findById.mockImplementation(async (id) => Object.values(users).find((u) => u.id === id));
  pool.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  pool.connect.mockResolvedValue(tx);
  tx.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

describe('PUT /rollouts/:flagId/:env', () => {
  const url = (env = 'staging', id = flagId) => `${api}/rollouts/${id}/${env}`;

  test('200: a Developer sets staging to 25%, the version goes up and it is audited', async () => {
    const { agent, csrf } = await signIn('developer');
    const res = await agent.put(url()).set('X-CSRF-Token', csrf).send({ percentage: 25, version: 3 }).expect(200);
    expect(res.body).toEqual({ flagId, env: 'staging', percentage: 25, version: 4, updatedAt: '2026-11-20T10:00:00.000Z' });
    expect(auditActions()).toEqual(['rollout.updated']);
    const auditCall = tx.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO audit_events'));
    expect(JSON.parse(auditCall[1][7])).toEqual({ key: 'new-checkout', env: 'staging', before: { percentage: 0 }, after: { percentage: 25 } });
    expect(tx.query).toHaveBeenCalledWith('COMMIT');
  });

  test('401 without a session', async () => {
    const res = await request(app).put(url()).send({ percentage: 25, version: 3 }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('403 CSRF_INVALID without the CSRF token', async () => {
    const { agent } = await signIn('developer');
    const res = await agent.put(url()).send({ percentage: 25, version: 3 }).expect(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  test('403 FORBIDDEN: a Developer cannot change prod, and access.denied is written', async () => {
    const { agent, csrf } = await signIn('developer');
    const res = await agent.put(url('prod')).set('X-CSRF-Token', csrf).send({ percentage: 25, version: 3 }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(auditActions()).toEqual(['access.denied']);
    expect(pool.connect).not.toHaveBeenCalled(); // refused before any rollout is read
  });

  test('200: an Admin can change prod', async () => {
    const { agent, csrf } = await signIn('admin');
    await agent.put(url('prod')).set('X-CSRF-Token', csrf).send({ percentage: 10, version: 3 }).expect(200);
  });

  test.each([
    [{ percentage: 101, version: 3 }, 'percentage must be a number between 0 and 100'],
    [{ percentage: -1, version: 3 }, 'percentage must be a number between 0 and 100'],
    [{ percentage: '25', version: 3 }, 'percentage must be a number between 0 and 100'],
    [{ percentage: 25.123, version: 3 }, 'percentage can have at most 2 decimals'],
    [{ percentage: 25 }, 'version must be the whole number you last read'],
    [{ percentage: 25, version: 3, env: 'prod' }, 'Unknown field: env.'],
  ])('400 VALIDATION_ERROR for %j', async (body, message) => {
    const { agent, csrf } = await signIn('developer');
    const res = await agent.put(url()).set('X-CSRF-Token', csrf).send(body).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message });
  });

  test('400 for an env that does not exist', async () => {
    const { agent, csrf } = await signIn('developer');
    const res = await agent.put(url('qa')).set('X-CSRF-Token', csrf).send({ percentage: 25, version: 3 }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('404 for another team\'s flag or a malformed id, never 403', async () => {
    const { agent, csrf } = await signIn('developer');
    await agent.put(url('staging', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).set('X-CSRF-Token', csrf)
      .send({ percentage: 25, version: 3 }).expect(404);
    await agent.put(url('staging', 'not-a-uuid')).set('X-CSRF-Token', csrf)
      .send({ percentage: 25, version: 3 }).expect(404);
    expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('409 STALE_VERSION when the version is old, and nothing is saved', async () => {
    const { agent, csrf } = await signIn('developer');
    const res = await agent.put(url()).set('X-CSRF-Token', csrf).send({ percentage: 25, version: 2 }).expect(409);
    expect(res.body.error.code).toBe('STALE_VERSION');
    expect(tx.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE rollouts'))).toBe(false);
    expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('POST /evaluations', () => {
  const url = `${api}/evaluations`;
  const call = (body, key = db.key.raw) => {
    const req = request(app).post(url);
    if (key) req.set('Authorization', `Bearer ${key}`);
    return req.send(body);
  };

  test('200: the flag value for the key\'s own environment', async () => {
    const res = await call({ flagKey: 'new-checkout', userId: 'u-981' }).expect(200);
    expect(res.body).toEqual({ flagKey: 'new-checkout', env: 'staging', enabled: true });
    expect(res.headers['set-cookie']).toBeUndefined(); // no session for client apps
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('the env comes from the key: an off flag answers false', async () => {
    db.setting.enabled = false;
    const res = await call({ flagKey: 'new-checkout', userId: 'u-981' }).expect(200);
    expect(res.body.enabled).toBe(false);
  });

  test('400 when the body tries to choose the env (ST-06)', async () => {
    const res = await call({ flagKey: 'new-checkout', userId: 'u-981', env: 'prod' }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Unknown field: env.' });
  });

  test.each([
    [{ userId: 'u-1' }],
    [{ flagKey: 'new-checkout' }],
    [{ flagKey: 'Bad Key!', userId: 'u-1' }],
    [{ flagKey: 'new-checkout', userId: '' }],
    [{ flagKey: 'new-checkout', userId: 'x'.repeat(101) }],
  ])('400 for a bad body %j', async (body) => {
    await call(body).expect(400);
  });

  test('401 without a key, with junk, or with an unknown key', async () => {
    await call({ flagKey: 'new-checkout', userId: 'u-1' }, null).expect(401);
    await call({ flagKey: 'new-checkout', userId: 'u-1' }, 'not-a-key').expect(401);
    const res = await call({ flagKey: 'new-checkout', userId: 'u-1' }, newKey('staging').raw).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('401 for a revoked key (ST-07), logged as access.denied', async () => {
    db.key.revoked = true;
    const res = await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(auditActions()).toEqual(['access.denied']);
  });

  test('a session cookie is not enough: signed-in users still need a key', async () => {
    const { agent } = await signIn('admin');
    await agent.post(url).send({ flagKey: 'new-checkout', userId: 'u-1' }).expect(401);
  });

  test('404 for a flag the key\'s team does not have', async () => {
    const res = await call({ flagKey: 'loyalty-points', userId: 'u-1' }).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('503 DB_UNAVAILABLE when the database is down', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.startsWith('INSERT INTO audit_events')) return { rows: [{ id: '1', at: new Date() }] };
      throw new Error('connect ECONNREFUSED');
    });
    const res = await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(503);
    expect(res.body.error.code).toBe('DB_UNAVAILABLE');
  });

  test('429 RATE_LIMITED after 120 requests in a minute, with Retry-After, logged once', async () => {
    db.usage = 119;
    await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(200); // number 120: still fine
    const first = await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(429);
    expect(first.body.error.code).toBe('RATE_LIMITED');
    const seconds = Number(first.headers['retry-after']);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(60);
    await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(429);
    await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(429);
    expect(auditActions()).toEqual(['rate_limit.hit']); // once, not once per refused request
  });

  test('a rate-limited key does not read the flag', async () => {
    db.usage = 500;
    await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(429);
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('FROM flags f'))).toBe(false);
  });

  test('unknown keys are not counted (no row for junk keys)', async () => {
    await call({ flagKey: 'new-checkout', userId: 'u-1' }, newKey('staging').raw).expect(401);
    expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO api_key_usage'))).toBe(false);
  });

  test('evaluations are not audited (it would flood the log)', async () => {
    await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(200);
    expect(auditActions()).toEqual([]);
  });

  test('lastUsedAt is updated, and a failure there does not change the answer', async () => {
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('UPDATE api_keys')) throw new Error('write failed');
      return fakeQuery(sql, params);
    });
    const res = await call({ flagKey: 'new-checkout', userId: 'u-1' }).expect(200);
    expect(res.body.enabled).toBe(true);
    expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE api_keys'))).toBe(true);
  });
});

describe('POST /evaluations/batch', () => {
  const url = `${api}/evaluations/batch`;
  const call = (body, key = db.key.raw) => {
    const req = request(app).post(url);
    if (key) req.set('Authorization', `Bearer ${key}`);
    return req.send(body);
  };
  const flagKeys = ['new-checkout', 'gift-wrap', 'paypal-v1', 'loyalty-points'];

  test('200: every flag for one user, unknown flags in notFound, all in one query', async () => {
    const res = await call({ userId: 'u-981', flagKeys }).expect(200);
    expect(res.body).toEqual({
      env: 'staging',
      flags: { 'new-checkout': false, 'gift-wrap': true, 'paypal-v1': false }, // archived is always off
      notFound: ['loyalty-points'],
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(pool.query.mock.calls.filter(([sql]) => sql.includes('FROM flags f'))).toHaveLength(1);
  });

  test('allow and block lists work per user, like the single evaluation', async () => {
    const beta = await call({ userId: 'u-beta-1', flagKeys }).expect(200);
    expect(beta.body.flags['new-checkout']).toBe(true); // allowlisted at 0%
    const fraud = await call({ userId: 'u-fraud-77', flagKeys }).expect(200);
    expect(fraud.body.flags['gift-wrap']).toBe(false); // blocklisted at 100%
  });

  test('a batch counts as ONE request for the rate limit', async () => {
    await call({ userId: 'u-1', flagKeys }).expect(200);
    expect(db.usage).toBe(1);
  });

  test('400 when the body tries to choose the env (ST-06)', async () => {
    const res = await call({ userId: 'u-1', flagKeys, env: 'prod' }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Unknown field: env.' });
  });

  test.each([
    [{ flagKeys }, 'userId is required'],
    [{ userId: 'u-1' }, 'flagKeys must be a list of flag keys'],
    [{ userId: 'u-1', flagKeys: 'new-checkout' }, 'flagKeys must be a list of flag keys'],
    [{ userId: 'u-1', flagKeys: [] }, 'flagKeys must have 1 to 50 flag keys'],
    [{ userId: 'u-1', flagKeys: Array.from({ length: 51 }, (_, i) => `flag-${i}`) }, 'flagKeys must have 1 to 50 flag keys'],
    [{ userId: 'u-1', flagKeys: ['Bad Key!'] }, 'each flagKey must be a valid flag key'],
    [{ userId: 'u-1', flagKeys: ['gift-wrap', 'gift-wrap'] }, 'flagKeys must not repeat a flag key'],
    [{ userId: '', flagKeys }, 'userId must be 1 to 100 characters'],
  ])('400 VALIDATION_ERROR for %j', async (body, message) => {
    const res = await call(body).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message });
  });

  test('401 without a key or with an unknown key, before the body is looked at', async () => {
    await call({ junk: true }, null).expect(401);
    await call({ userId: 'u-1', flagKeys }, newKey('staging').raw).expect(401);
  });

  test('401 for a revoked key (ST-07), logged as access.denied', async () => {
    db.key.revoked = true;
    await call({ userId: 'u-1', flagKeys }).expect(401);
    expect(auditActions()).toEqual(['access.denied']);
  });

  test('429 when the key is over the limit, and the flags are not read', async () => {
    db.usage = 500;
    const res = await call({ userId: 'u-1', flagKeys }).expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('FROM flags f'))).toBe(false);
  });

  test('503 DB_UNAVAILABLE when the database is down', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.startsWith('INSERT INTO audit_events')) return { rows: [{ id: '1', at: new Date() }] };
      throw new Error('connect ECONNREFUSED');
    });
    await call({ userId: 'u-1', flagKeys }).expect(503);
  });
});
