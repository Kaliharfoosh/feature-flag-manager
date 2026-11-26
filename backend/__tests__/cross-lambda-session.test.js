// On AWS each service is its own Lambda, so one browser talks to SEVERAL Express apps. A login
// made through ffm-flags-fn must work in ffm-eval-fn and ffm-audit-fn: same cookie, same session
// row, same CSRF token. Here two separate apps (flags and eval) share one session store, just as
// the Lambdas share Neon's `session` table. The database itself is mocked.
jest.mock('../middleware/turnstile', () => ({
  ...jest.requireActual('../middleware/turnstile'), verifyTurnstile: jest.fn(),
}));
// One store for every app built in this file = the shared `session` table.
jest.mock('connect-pg-simple', () => (session) => {
  const shared = new session.MemoryStore();
  return function SharedStore() { return shared; };
});
jest.mock('../db/pool', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../services/auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../services/audit-alerts/github', () => ({
  ...jest.requireActual('../services/audit-alerts/github'), deliverPending: jest.fn(),
}));

process.env.SESSION_SECRET = 'one-secret-shared-by-every-lambda';
process.env.LOG_LEVEL = 'silent';

const request = require('supertest');
const { buildApp } = require('../build-app');
const { pool } = require('../db/pool');
const authService = require('../services/auth/service');

const flagsFn = buildApp({ services: ['flags'] });   // ffm-flags-fn
const evalFn = buildApp({ services: ['eval'] });     // ffm-eval-fn
const auditFn = buildApp({ services: ['audit'] });   // ffm-audit-fn

const teamId = '699df5c7-e092-4a81-b7cb-14d6ea382378';
const flagId = '3d6e0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const admin = { id: 'c72f08c0-3a44-4f92-8379-0375da225f99', email: 'admin@acme.test', name: 'Amira Admin', role: 'admin', teamId };
const tx = { query: jest.fn(), release: jest.fn() };

function fakeQuery(sql, params = []) {
  if (sql.startsWith('INSERT INTO audit_events')) return { rows: [{ id: '77', at: new Date() }] };
  if (sql.startsWith('SELECT id, key FROM flags')) return { rows: params[0] === flagId ? [{ id: flagId, key: 'new-checkout' }] : [] };
  if (sql.startsWith('SELECT percentage, version FROM rollouts')) return { rows: [{ percentage: '0.00', version: 3 }] };
  if (sql.startsWith('UPDATE rollouts')) return { rows: [{ percentage: params[2].toFixed(2), version: 4, updatedAt: new Date() }] };
  return { rows: [] };
}

beforeEach(() => {
  jest.clearAllMocks();
  authService.findById.mockImplementation(async (id) => (id === admin.id ? admin : undefined));
  pool.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  pool.connect.mockResolvedValue(tx);
  tx.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
});

// Log in through ffm-flags-fn and return the cookie + CSRF token the browser would keep.
async function signInThroughFlags() {
  authService.authenticate.mockResolvedValueOnce({ user: admin, rateLimited: false });
  const login = await request(flagsFn).post('/api/v1/auth/login')
    .send({ email: admin.email, password: 'irrelevant-here' }).expect(200);
  const cookie = login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
  const me = await request(flagsFn).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
  return { cookie, csrf: me.body.csrfToken };
}

test('a login made in ffm-flags-fn is accepted by ffm-eval-fn, including the CSRF token', async () => {
  const { cookie, csrf } = await signInThroughFlags();
  const res = await request(evalFn).put(`/api/v1/rollouts/${flagId}/staging`)
    .set('Cookie', cookie).set('X-CSRF-Token', csrf)
    .send({ percentage: 25, version: 3 }).expect(200);
  expect(res.body).toMatchObject({ flagId, env: 'staging', percentage: 25, version: 4 });
  expect(res.headers['x-served-by']).toBe('eval');
});

test('the same login reaches ffm-audit-fn (Admin-only monitoring page)', async () => {
  const { cookie } = await signInThroughFlags();
  const res = await request(auditFn).get('/api/v1/alert-rules').set('Cookie', cookie);
  expect(res.status).not.toBe(401);
  expect(res.headers['x-served-by']).toBe('audit');
});

test('ffm-eval-fn still refuses a write without the CSRF token', async () => {
  const { cookie } = await signInThroughFlags();
  const res = await request(evalFn).put(`/api/v1/rollouts/${flagId}/staging`)
    .set('Cookie', cookie).send({ percentage: 25, version: 3 }).expect(403);
  expect(res.body.error.code).toBe('CSRF_INVALID');
});

test('after logout in ffm-flags-fn, ffm-eval-fn no longer accepts the cookie', async () => {
  const { cookie, csrf } = await signInThroughFlags();
  await request(flagsFn).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrf).expect(204);
  const res = await request(evalFn).get(`/api/v1/rollouts/${flagId}`).set('Cookie', cookie).expect(401);
  expect(res.body.error.code).toBe('UNAUTHENTICATED');
});
