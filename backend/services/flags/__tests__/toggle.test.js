const request = require('supertest');

jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../../db/pool', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../../auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../../../shared/audit', () => ({ record: jest.fn(), recordSecurity: jest.fn() }));
jest.mock('../../audit-alerts/github', () => ({ deliverPending: jest.fn() }));

process.env.SESSION_SECRET = 'session-secret-for-toggle-tests';
process.env.LOG_LEVEL = 'silent';

const app = require('../../../app');
const { pool } = require('../../../db/pool');
const auth = require('../../auth/service');
const audit = require('../../../shared/audit');
const github = require('../../audit-alerts/github');
const flagId = '3d6e0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const user = {
  id: 'c72f08c0-3a44-4f92-8379-0375da225f99', teamId: '699df5c7-e092-4a81-b7cb-14d6ea382378',
  email: 'dev@acme.test', role: 'developer', name: 'Developer',
};
const tx = { query: jest.fn(), release: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  auth.authenticate.mockResolvedValue({ user, rateLimited: false });
  auth.findById.mockResolvedValue(user);
  pool.connect.mockResolvedValue(tx);
  tx.query.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT id, key FROM flags')) return { rows: [{ id: flagId, key: 'beta-search' }] };
    if (sql.startsWith('SELECT enabled, version')) return { rows: [{ enabled: false, version: 1 }] };
    if (sql.startsWith('UPDATE flag_environments')) return { rows: [{ enabled: true, version: 2, updatedAt: new Date() }] };
    return { rows: [] };
  });
});

async function signIn(role = 'developer') {
  auth.findById.mockResolvedValue({ ...user, role });
  auth.authenticate.mockResolvedValue({ user: { ...user, role }, rateLimited: false });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email: user.email, password: 'unused-test-password' }).expect(200);
  const me = await agent.get('/api/v1/auth/me').expect(200);
  return { agent, csrf: me.body.csrfToken };
}

const url = (env = 'staging', id = flagId) => `/api/v1/flags/${id}/environments/${env}`;

test('requires authentication and CSRF before opening the transaction', async () => {
  await request(app).patch(url()).send({ enabled: true, version: 1 }).expect(401);
  const { agent } = await signIn();
  await agent.patch(url()).send({ enabled: true, version: 1 }).expect(403);
  expect(pool.connect).not.toHaveBeenCalled();
});

test.each([
  ['staging', flagId, { enabled: 'yes', version: 1 }],
  ['staging', flagId, { enabled: true }],
  ['staging', flagId, { enabled: true, version: 0 }],
  ['live', flagId, { enabled: true, version: 1 }],
  ['staging', 'invalid-id', { enabled: true, version: 1 }],
])('validates environment, id, enabled and version', async (env, id, body) => {
  const { agent, csrf } = await signIn();
  const response = await agent.patch(url(env, id)).set('X-CSRF-Token', csrf).send(body).expect(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(pool.connect).not.toHaveBeenCalled();
});

test('a Developer can change staging and alerts are delivered after commit', async () => {
  const { agent, csrf } = await signIn();
  const response = await agent.patch(url()).set('X-CSRF-Token', csrf).send({ enabled: true, version: 1 }).expect(200);
  expect(response.body).toMatchObject({ flagId, env: 'staging', enabled: true, version: 2 });
  expect(audit.record).toHaveBeenCalledWith(tx, expect.objectContaining({ user }), expect.objectContaining({
    action: 'flag.toggled', details: { key: 'beta-search', env: 'staging' },
    before: { enabled: false }, after: { enabled: true },
  }));
  expect(tx.query).toHaveBeenLastCalledWith('COMMIT');
  expect(tx.release.mock.invocationCallOrder[0]).toBeLessThan(github.deliverPending.mock.invocationCallOrder.at(-1));
});

test('a Developer production denial is audited and cannot change the environment', async () => {
  const { agent, csrf } = await signIn();
  const response = await agent.patch(url('prod')).set('X-CSRF-Token', csrf).send({ enabled: true, version: 1 }).expect(403);
  expect(response.body.error.code).toBe('FORBIDDEN');
  expect(audit.recordSecurity).toHaveBeenCalledWith(expect.any(Object), 'access.denied', expect.objectContaining({ requiredRole: 'admin' }));
  expect(tx.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  expect(tx.query).toHaveBeenLastCalledWith('ROLLBACK');
});

test('an Admin can change production', async () => {
  const { agent, csrf } = await signIn('admin');
  await agent.patch(url('prod')).set('X-CSRF-Token', csrf).send({ enabled: true, version: 1 }).expect(200);
});

test('foreign-team ids return 404 before a production role check', async () => {
  const { agent, csrf } = await signIn();
  const query = tx.query.getMockImplementation();
  tx.query.mockImplementation(async (sql, args) => sql.startsWith('SELECT id, key FROM flags') ? { rows: [] } : query(sql, args));
  await agent.patch(url('prod')).set('X-CSRF-Token', csrf).send({ enabled: true, version: 1 }).expect(404);
  expect(audit.recordSecurity).not.toHaveBeenCalled();
});

test('single flag lookup scopes the SQL to the signed-in team', async () => {
  const { agent } = await signIn();
  pool.query.mockResolvedValueOnce({ rows: [] });
  await agent.get('/api/v1/flags/' + flagId).expect(404);
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('f.team_id = $2'), [flagId, user.teamId]);
});
