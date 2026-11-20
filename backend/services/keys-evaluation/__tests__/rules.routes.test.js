// Route tests for GET /rollouts/:flagId, the allow/block rules and POST /preview through the real
// Express app (real sessions, CSRF, requireAuth, requireRole). The database is mocked;
// rules.db.test.js runs the same SQL against a real Postgres.
const request = require('supertest');

jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../../db/pool', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../../auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../../audit-alerts/github', () => ({
  ...jest.requireActual('../../audit-alerts/github'), deliverPending: jest.fn(),
}));

process.env.SESSION_SECRET = 'session-secret-for-rules-tests';
process.env.LOG_LEVEL = 'silent';

const app = require('../../../app');
const { pool } = require('../../../db/pool');
const authService = require('../../auth/service');
const { bucket } = require('../evaluate');

const api = '/api/v1';
const teamId = '699df5c7-e092-4a81-b7cb-14d6ea382378';
const flagId = '3d6e0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const ruleId = 'c0ffee00-1111-4222-8333-444455556666';
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const users = {
  admin: { id: 'c72f08c0-3a44-4f92-8379-0375da225f99', email: 'admin@acme.test', name: 'Amira Admin', role: 'admin', teamId },
  developer: { id: 'd1e2f3a4-0000-4000-8000-000000000002', email: 'dev@acme.test', name: 'Dina Developer', role: 'developer', teamId },
};
const tx = { query: jest.fn(), release: jest.fn() };
const created = new Date('2026-11-20T10:00:00Z');

// A tiny fake database: one flag ("new-checkout") and a list of rules.
let db;
const ours = (id) => id === flagId;
function fakeQuery(sql, params = []) {
  if (sql.startsWith('INSERT INTO audit_events')) return { rows: [{ id: '77', at: new Date() }] };
  if (sql.includes('CROSS JOIN unnest')) { // getRollouts
    if (!(ours(params[0]) && params[1] === teamId)) return { rows: [] };
    return { rows: [{ env: 'dev', percentage: '100.00', version: 2 }, { env: 'staging', percentage: '25.00', version: 4 }, { env: 'prod', percentage: null, version: null }] };
  }
  if (sql.startsWith('SELECT id, key FROM flags')) {
    return { rows: ours(params[0]) && params[1] === teamId ? [{ id: flagId, key: 'new-checkout' }] : [] };
  }
  if (sql.includes('FROM user_rules WHERE flag_id')) return { rows: db.rules.filter((r) => r.env === params[1]).map(({ env, ...r }) => r) };
  if (sql.startsWith('INSERT INTO user_rules')) {
    if (db.rules.some((r) => r.env === params[1] && r.userId === params[2])) return { rows: [] };
    const rule = { id: ruleId, env: params[1], userId: params[2], kind: params[3], createdAt: created };
    db.rules.push(rule);
    const { env, ...out } = rule;
    return { rows: [out] };
  }
  if (sql.includes('FROM user_rules ur JOIN flags f')) {
    const rule = db.rules.find((r) => r.id === params[0]);
    return { rows: rule && params[1] === teamId ? [{ ...rule, flagKey: 'new-checkout' }] : [] };
  }
  if (sql.startsWith('DELETE FROM user_rules')) {
    const before = db.rules.length;
    db.rules = db.rules.filter((r) => r.id !== params[0]);
    return { rows: [], rowCount: before - db.rules.length };
  }
  if (sql.includes('FROM flags f')) { // loadSetting (preview)
    if (params[2] !== 'new-checkout') return { rows: [] };
    const here = db.rules.filter((r) => r.env === params[1]);
    return { rows: [{ ...db.setting, allow: here.filter((r) => r.kind === 'allow').map((r) => r.userId), block: here.filter((r) => r.kind === 'block').map((r) => r.userId) }] };
  }
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
  db = { rules: [], setting: { archived: false, enabled: true, percentage: '25.00' } };
  authService.findById.mockImplementation(async (id) => Object.values(users).find((u) => u.id === id));
  pool.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  pool.connect.mockResolvedValue(tx);
  tx.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

describe('GET /rollouts/:flagId', () => {
  test('200: all three envs; a missing row reads as 0%, version 1', async () => {
    const { agent } = await signIn('developer');
    const res = await agent.get(`${api}/rollouts/${flagId}`).expect(200);
    expect(res.body).toEqual({
      flagId,
      environments: { dev: { percentage: 100, version: 2 }, staging: { percentage: 25, version: 4 }, prod: { percentage: 0, version: 1 } },
    });
  });

  test('401 without a session, 404 for another team or a bad id', async () => {
    await request(app).get(`${api}/rollouts/${flagId}`).expect(401);
    const { agent } = await signIn('developer');
    await agent.get(`${api}/rollouts/${otherId}`).expect(404);
    await agent.get(`${api}/rollouts/nope`).expect(404);
  });
});

describe('allow / block rules', () => {
  const rulesUrl = (env = 'staging', id = flagId) => `${api}/rollouts/${id}/${env}/rules`;

  test('add, list and delete a rule, each write audited', async () => {
    const { agent, csrf } = await signIn('developer');
    const added = await agent.post(rulesUrl()).set('X-CSRF-Token', csrf).send({ userId: 'u-981', kind: 'allow' }).expect(201);
    expect(added.body).toEqual({ id: ruleId, userId: 'u-981', kind: 'allow', createdAt: created.toISOString() });

    const list = await agent.get(rulesUrl()).expect(200);
    expect(list.body.items).toEqual([added.body]);

    await agent.delete(`${api}/rules/${ruleId}`).set('X-CSRF-Token', csrf).expect(204);
    expect((await agent.get(rulesUrl()).expect(200)).body.items).toEqual([]);
    expect(auditActions()).toEqual(['rule.added', 'rule.removed']);
  });

  test('409 CONFLICT when the user already has a rule here', async () => {
    const { agent, csrf } = await signIn('developer');
    await agent.post(rulesUrl()).set('X-CSRF-Token', csrf).send({ userId: 'u-1', kind: 'allow' }).expect(201);
    const res = await agent.post(rulesUrl()).set('X-CSRF-Token', csrf).send({ userId: 'u-1', kind: 'block' }).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(tx.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test.each([
    [{ userId: 'u-1' }, 'kind must be allow or block'],
    [{ userId: 'u-1', kind: 'maybe' }, 'kind must be allow or block'],
    [{ kind: 'allow' }, 'userId is required'],
    [{ userId: '', kind: 'allow' }, 'userId must be 1 to 100 characters'],
    [{ userId: 'x'.repeat(101), kind: 'allow' }, 'userId must be 1 to 100 characters'],
    [{ userId: 'u-1', kind: 'allow', env: 'prod' }, 'Unknown field: env.'],
  ])('400 VALIDATION_ERROR for %j', async (body, message) => {
    const { agent, csrf } = await signIn('developer');
    const res = await agent.post(rulesUrl()).set('X-CSRF-Token', csrf).send(body).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message });
  });

  test('400 for a bad env; 404 for another team\'s flag', async () => {
    const { agent, csrf } = await signIn('developer');
    await agent.get(rulesUrl('qa')).expect(400);
    await agent.get(rulesUrl('staging', otherId)).expect(404);
    await agent.post(rulesUrl('staging', otherId)).set('X-CSRF-Token', csrf).send({ userId: 'u-1', kind: 'allow' }).expect(404);
  });

  test('401 without a session; 403 CSRF_INVALID without the token', async () => {
    await request(app).get(rulesUrl()).expect(401);
    const { agent } = await signIn('developer');
    const res = await agent.post(rulesUrl()).send({ userId: 'u-1', kind: 'allow' }).expect(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
    await agent.delete(`${api}/rules/${ruleId}`).expect(403);
  });

  test('prod rule: a Developer cannot add or delete a prod rule (403 + access.denied); an Admin can', async () => {
    db.rules.push({ id: ruleId, env: 'prod', userId: 'u-1', kind: 'block', createdAt: created });
    const dev = await signIn('developer');
    await dev.agent.post(rulesUrl('prod')).set('X-CSRF-Token', dev.csrf).send({ userId: 'u-2', kind: 'allow' }).expect(403);
    await dev.agent.delete(`${api}/rules/${ruleId}`).set('X-CSRF-Token', dev.csrf).expect(403);
    expect(auditActions()).toEqual(['access.denied', 'access.denied']);
    expect(db.rules).toHaveLength(1); // nothing changed

    const admin = await signIn('admin');
    await admin.agent.delete(`${api}/rules/${ruleId}`).set('X-CSRF-Token', admin.csrf).expect(204);
    expect(db.rules).toHaveLength(0);
  });

  test('a Developer can still read prod rules', async () => {
    const { agent } = await signIn('developer');
    await agent.get(rulesUrl('prod')).expect(200);
  });

  test('DELETE: 404 for an unknown, other-team or malformed rule id', async () => {
    const { agent, csrf } = await signIn('developer');
    await agent.delete(`${api}/rules/${otherId}`).set('X-CSRF-Token', csrf).expect(404);
    await agent.delete(`${api}/rules/not-a-uuid`).set('X-CSRF-Token', csrf).expect(404);
  });
});

describe('POST /preview', () => {
  const url = `${api}/preview`;

  test('200 with the reason and the bucket', async () => {
    const { agent, csrf } = await signIn('developer');
    const res = await agent.post(url).set('X-CSRF-Token', csrf).send({ flagKey: 'new-checkout', env: 'staging', userId: 'u-981' }).expect(200);
    const b = bucket('new-checkout', 'u-981');
    expect(res.body).toEqual({
      flagKey: 'new-checkout', env: 'staging', userId: 'u-981',
      enabled: b < 2500, reason: b < 2500 ? 'in-percentage' : 'out-of-percentage', bucket: b,
    });
    expect(auditActions()).toEqual([]); // reads only, nothing written
  });

  test('uses the allow and block lists', async () => {
    db.rules.push({ id: ruleId, env: 'staging', userId: 'u-vip', kind: 'allow', createdAt: created });
    db.rules.push({ id: otherId, env: 'staging', userId: 'u-bad', kind: 'block', createdAt: created });
    const { agent, csrf } = await signIn('developer');
    const vip = await agent.post(url).set('X-CSRF-Token', csrf).send({ flagKey: 'new-checkout', env: 'staging', userId: 'u-vip' }).expect(200);
    expect(vip.body).toMatchObject({ enabled: true, reason: 'allowlisted' });
    const bad = await agent.post(url).set('X-CSRF-Token', csrf).send({ flagKey: 'new-checkout', env: 'staging', userId: 'u-bad' }).expect(200);
    expect(bad.body).toMatchObject({ enabled: false, reason: 'blocklisted' });
  });

  test('403 for a Developer on prod (access.denied), 200 for an Admin', async () => {
    const dev = await signIn('developer');
    await dev.agent.post(url).set('X-CSRF-Token', dev.csrf).send({ flagKey: 'new-checkout', env: 'prod', userId: 'u-1' }).expect(403);
    expect(auditActions()).toEqual(['access.denied']);
    const admin = await signIn('admin');
    await admin.agent.post(url).set('X-CSRF-Token', admin.csrf).send({ flagKey: 'new-checkout', env: 'prod', userId: 'u-1' }).expect(200);
  });

  test('400 for a bad body, 404 for an unknown flag key, 401/403 without session/CSRF', async () => {
    const { agent, csrf } = await signIn('developer');
    await agent.post(url).set('X-CSRF-Token', csrf).send({ flagKey: 'new-checkout', userId: 'u-1' }).expect(400);
    await agent.post(url).set('X-CSRF-Token', csrf).send({ flagKey: 'new-checkout', env: 'qa', userId: 'u-1' }).expect(400);
    await agent.post(url).set('X-CSRF-Token', csrf).send({ flagKey: 'nope-flag', env: 'staging', userId: 'u-1' }).expect(404);
    await agent.post(url).send({ flagKey: 'new-checkout', env: 'staging', userId: 'u-1' }).expect(403);
    await request(app).post(url).send({ flagKey: 'new-checkout', env: 'staging', userId: 'u-1' }).expect(401);
  });
});
