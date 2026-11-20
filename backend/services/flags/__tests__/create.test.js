const request = require('supertest');

jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../../db/pool', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../../auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../../../shared/audit', () => ({ record: jest.fn(), recordSecurity: jest.fn() }));

process.env.SESSION_SECRET = 'session-secret-for-create-tests';
process.env.LOG_LEVEL = 'silent';

const app = require('../../../app');
const { pool } = require('../../../db/pool');
const auth = require('../../auth/service');
const audit = require('../../../shared/audit');

const user = {
  id: 'c72f08c0-3a44-4f92-8379-0375da225f99',
  teamId: '699df5c7-e092-4a81-b7cb-14d6ea382378',
  email: 'dev@acme.test', name: 'Dina Developer', role: 'developer',
};
const flag = {
  id: '3d6e0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b',
  key: 'beta-search', name: 'Beta search', description: '', archived: false,
  version: 1, createdBy: user.id, createdAt: new Date(), updatedAt: new Date(),
};
const tx = { query: jest.fn(), release: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  auth.authenticate.mockResolvedValue({ user, rateLimited: false });
  auth.findById.mockResolvedValue(user);
  pool.connect.mockResolvedValue(tx);
  tx.query.mockImplementation(async (sql) => {
    if (sql.includes('INSERT INTO flags')) return { rows: [flag] };
    if (sql.startsWith('SELECT env, percentage')) {
      return { rows: ['dev', 'staging', 'prod'].map(env => ({ env, percentage: '0.00', version: 1 })) };
    }
    return { rows: [] };
  });
  audit.record.mockResolvedValue({ id: 1, alert: null });
});

async function signIn() {
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email: user.email, password: 'demo-test-password' }).expect(200);
  const me = await agent.get('/api/v1/auth/me').expect(200);
  return { agent, csrf: me.body.csrfToken };
}

test('requires a signed-in user and a CSRF token before opening a transaction', async () => {
  await request(app).post('/api/v1/flags').send({}).expect(401);
  const { agent } = await signIn();
  await agent.post('/api/v1/flags').send({ key: flag.key, name: flag.name }).expect(403);
  expect(pool.connect).not.toHaveBeenCalled();
});

test('a Developer creates defaults and audit in one transaction, ignoring server-owned fields', async () => {
  const { agent, csrf } = await signIn();
  const response = await agent.post('/api/v1/flags').set('X-CSRF-Token', csrf).send({
    key: flag.key, name: '  Beta search  ', id: user.id, teamId: 'another-team',
    enabled: true, version: 99, createdAt: 'yesterday',
  }).expect(201);
  expect(response.body).toMatchObject({ id: flag.id, version: 1, createdBy: user.id });
  expect(response.body.environments).toEqual(Object.fromEntries(
    ['dev', 'staging', 'prod'].map(env => [env, { enabled: false, percentage: 0, version: 1 }]),
  ));
  const insert = tx.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO flags'));
  expect(insert[1]).toEqual([user.teamId, flag.key, flag.name, '', user.id]);
  expect(audit.record).toHaveBeenCalledWith(tx, expect.objectContaining({ user }), expect.objectContaining({
    action: 'flag.created', targetId: flag.id, after: { key: flag.key, name: flag.name, description: '', archived: false, version: 1 },
  }));
  expect(tx.query.mock.calls[0]).toEqual(['BEGIN']);
  expect(tx.query).toHaveBeenLastCalledWith('COMMIT');
  expect(tx.release).toHaveBeenCalledTimes(1);
});

test.each([
  [{ key: 'Bad Key!', name: 'Valid' }, 'key'],
  [{ key: 'beta-search', name: '   ' }, 'name'],
  [{ key: 'beta-search', name: 'Valid', description: 'x'.repeat(501) }, 'description'],
])('rejects invalid create input', async (body, field) => {
  const { agent, csrf } = await signIn();
  const response = await agent.post('/api/v1/flags').set('X-CSRF-Token', csrf).send(body).expect(400);
  expect(response.body.error.message).toContain(field);
  expect(pool.connect).not.toHaveBeenCalled();
});

test('a duplicate key rolls back and returns a conflict', async () => {
  const { agent, csrf } = await signIn();
  const query = tx.query.getMockImplementation();
  tx.query.mockImplementation(async (sql, params) => {
    if (sql.includes('INSERT INTO flags')) throw Object.assign(new Error('duplicate'), { code: '23505', constraint: 'flags_team_id_key_key' });
    return query(sql, params);
  });
  const response = await agent.post('/api/v1/flags').set('X-CSRF-Token', csrf)
    .send({ key: flag.key, name: flag.name }).expect(409);
  expect(response.body.error.code).toBe('CONFLICT');
  expect(tx.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(audit.record).not.toHaveBeenCalled();
});

test('an audit failure rolls back the flag and all default rows', async () => {
  const { agent, csrf } = await signIn();
  audit.record.mockRejectedValueOnce(new Error('audit unavailable'));
  await agent.post('/api/v1/flags').set('X-CSRF-Token', csrf)
    .send({ key: flag.key, name: flag.name }).expect(500);
  expect(tx.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(tx.release).toHaveBeenCalledTimes(1);
});
