jest.mock('../../../middleware/turnstile', () => ({
  ...jest.requireActual('../../../middleware/turnstile'), verifyTurnstile: jest.fn(),
}));
jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../../db/pool', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../../auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../../../shared/audit', () => ({ record: jest.fn(), recordSecurity: jest.fn() }));
jest.mock('../../audit-alerts/github', () => ({ deliverPending: jest.fn() }));

process.env.SESSION_SECRET = 'keys-route-tests-only';
process.env.LOG_LEVEL = 'silent';
const request = require('supertest');
const app = require('../../../app');
const { buildApp } = require('../../../build-app');
const { pool } = require('../../../db/pool');
const auth = require('../../auth/service');
const audit = require('../../../shared/audit');
const id = '64dc7ea1-a7da-49ba-9aef-5104a6762aee';
const user = { id, teamId: id, email: 'key-admin@acme.test', role: 'admin', name: 'Key Admin' };
const url = '/api/v1/keys';

beforeEach(() => {
  jest.clearAllMocks();
  auth.authenticate.mockResolvedValue({ user, rateLimited: false });
  auth.findById.mockResolvedValue(user);
  pool.query.mockResolvedValue({ rows: [] });
});

async function signIn(role = 'admin') {
  auth.authenticate.mockResolvedValue({ user: { ...user, role }, rateLimited: false });
  auth.findById.mockResolvedValue({ ...user, role });
  const agent = request.agent(app);
  await agent.post('/api/v1/auth/login').send({ email: user.email, password: 'not-used-here' }).expect(200);
  const me = await agent.get('/api/v1/auth/me').expect(200);
  return { agent, csrf: me.body.csrfToken };
}

test.each(['get', 'post', 'delete'])('%s requires a session, not an API key', async (method) => {
  await request(app)[method](method === 'delete' ? `${url}/${id}` : url)
    .set('Authorization', 'Bearer ffm_stg_thisIsNotASessionCookie123456789').expect(401);
  expect(pool.connect).not.toHaveBeenCalled();
});

test.each(['get', 'post', 'delete'])('Developer %s is refused and audited (ST-08)', async (method) => {
  const { agent, csrf } = await signIn('developer');
  const response = await agent[method](method === 'delete' ? `${url}/${id}` : url)
    .set('X-CSRF-Token', csrf).send(method === 'post' ? { name: 'Forbidden', env: 'dev' } : undefined).expect(403);
  expect(response.body.error.code).toBe('FORBIDDEN');
  expect(audit.recordSecurity).toHaveBeenCalledWith(expect.any(Object), 'access.denied', expect.objectContaining({ requiredRole: 'admin' }));
  expect(pool.connect).not.toHaveBeenCalled();
  expect(pool.query).not.toHaveBeenCalled();
});

test.each(['post', 'delete'])('%s requires a valid CSRF token before a write', async (method) => {
  const { agent } = await signIn();
  for (const token of ['', 'wrong-token']) {
    const response = await agent[method](method === 'delete' ? `${url}/${id}` : url)
      .set('X-CSRF-Token', token).send(method === 'post' ? { name: 'Store', env: 'dev' } : undefined).expect(403);
    expect(response.body.error.code).toBe('CSRF_INVALID');
  }
  expect(pool.connect).not.toHaveBeenCalled();
});

test.each([
  {}, { name: '', env: 'staging' }, { name: '   ', env: 'dev' },
  { name: 'x'.repeat(61), env: 'dev' }, { name: 'Store', env: 'other' },
  { name: 'Store', env: 'prod', teamId: id }, { name: 'Store', env: 'dev', key: 'caller-secret' },
  { name: 42, env: 'staging' },
])('create validates strictly: %j', async (body) => {
  const { agent, csrf } = await signIn();
  const response = await agent.post(url).set('X-CSRF-Token', csrf).send(body).expect(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(pool.connect).not.toHaveBeenCalled();
});

test('malformed revoke id and unexpected list filters are rejected', async () => {
  const { agent, csrf } = await signIn();
  await agent.delete(`${url}/not-an-id`).set('X-CSRF-Token', csrf).expect(400);
  await agent.get(`${url}?teamId=${id}`).expect(400);
  expect(pool.connect).not.toHaveBeenCalled();
  expect(pool.query).not.toHaveBeenCalled();
});

test('list is team-scoped and never cacheable', async () => {
  const { agent } = await signIn();
  const response = await agent.get(url).expect(200);
  expect(response.body).toEqual({ items: [] });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE team_id = $1'), [user.teamId]);
});

test('keys are part of the flags Lambda, not the evaluation or audit Lambdas', async () => {
  await request(buildApp({ services: ['flags'] })).get(url).expect(401);
  for (const service of ['eval', 'audit']) await request(buildApp({ services: [service] })).get(url).expect(404);
});
