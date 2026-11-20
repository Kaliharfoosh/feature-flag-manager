const request = require('supertest');

jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../../db/pool', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../../../shared/audit', () => ({ recordSecurity: jest.fn(), record: jest.fn() }));

process.env.SESSION_SECRET = 'session-secret-for-turnstile-tests';
process.env.LOG_LEVEL = 'silent';

const app = require('../../../app');
const { pool } = require('../../../db/pool');
const auth = require('../service');
const audit = require('../../../shared/audit');
const { getClientConfig } = require('../../../middleware/turnstile');
const environmentNames = ['NODE_ENV', 'VERCEL_ENV', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_HOSTNAMES'];
const initial = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
const credentials = { email: 'admin@acme.test', password: 'unused-demo-password' };
const user = { id: 'c72f08c0-3a44-4f92-8379-0375da225f99', teamId: '699df5c7-e092-4a81-b7cb-14d6ea382378', email: credentials.email, role: 'admin' };
let fetchMock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = 'production';
  delete process.env.VERCEL_ENV;
  process.env.TURNSTILE_SITE_KEY = 'real-site-key';
  process.env.TURNSTILE_SECRET_KEY = 'private-test-secret';
  process.env.TURNSTILE_HOSTNAMES = 'flags.example.test';
  pool.query.mockResolvedValue({ rows: [{ teamId: user.teamId }] });
  auth.authenticate.mockResolvedValue({ user, rateLimited: false });
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true, json: async () => ({ success: true, action: 'login', hostname: 'flags.example.test' }),
  });
});

afterEach(() => {
  fetchMock.mockRestore();
  for (const name of environmentNames) {
    if (initial[name] === undefined) delete process.env[name];
    else process.env[name] = initial[name];
  }
});

test('exposes the public widget key and action without the secret', async () => {
  const response = await request(app).get('/api/v1/auth/config').expect(200);
  expect(response.body).toEqual({ siteKey: 'real-site-key', action: 'login' });
  expect(JSON.stringify(response.body)).not.toContain(process.env.TURNSTILE_SECRET_KEY);
  expect(response.headers['cache-control']).toBe('no-store');
});

test('a missing token is audited before password authentication and cannot create a session', async () => {
  const response = await request(app).post('/api/v1/auth/login').send(credentials).expect(403);
  expect(response.body.error.code).toBe('BOT_CHECK_FAILED');
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(auth.authenticate).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(audit.recordSecurity).toHaveBeenCalledWith(expect.any(Object), 'bot_check.failed', { reason: 'missing_or_invalid_token' }, { teamId: user.teamId });
  expect(pool.connect).not.toHaveBeenCalled();
});

test('sends the token to Siteverify before checking the password', async () => {
  await request(app).post('/api/v1/auth/login').set('X-Turnstile-Token', 'fresh-token').send(credentials).expect(200);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(JSON.parse(options.body)).toMatchObject({ secret: 'private-test-secret', response: 'fresh-token' });
  expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(auth.authenticate.mock.invocationCallOrder[0]);
});

test.each([
  { success: false, 'error-codes': ['timeout-or-duplicate'] },
  { success: true, action: 'another-action', hostname: 'flags.example.test' },
  { success: true, action: 'login', hostname: 'another.example.test' },
])('rejects expired, replayed or mismatched verification results', async (result) => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => result });
  const response = await request(app).post('/api/v1/auth/login').set('X-Turnstile-Token', 'spent-token').send(credentials).expect(403);
  expect(response.body.error.code).toBe('BOT_CHECK_FAILED');
  expect(auth.authenticate).not.toHaveBeenCalled();
});

test('verification outages fail closed and are recorded without incrementing login attempts', async () => {
  fetchMock.mockRejectedValueOnce(new Error('network unavailable'));
  const response = await request(app).post('/api/v1/auth/login').set('X-Turnstile-Token', 'fresh-token').send(credentials).expect(503);
  expect(response.body.error.code).toBe('BOT_CHECK_UNAVAILABLE');
  expect(auth.authenticate).not.toHaveBeenCalled();
  expect(pool.query.mock.calls.every(([sql]) => !sql.includes('login_attempts'))).toBe(true);
  expect(audit.recordSecurity).toHaveBeenCalledWith(expect.any(Object), 'bot_check.failed', { reason: 'verification_unavailable' }, { teamId: user.teamId });
});

test('production refuses missing keys and official dummy keys', async () => {
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  await request(app).get('/api/v1/auth/config').expect(503);
  process.env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
  await request(app).post('/api/v1/auth/login').set('X-Turnstile-Token', 'XXXX.DUMMY.TOKEN.XXXX').send(credentials).expect(503);
  expect(auth.authenticate).not.toHaveBeenCalled();
});

test('local and Preview test keys still call Siteverify and accept its documented dummy response', async () => {
  process.env.VERCEL_ENV = 'preview';
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  expect(getClientConfig()).toEqual({ siteKey: '1x00000000000000000000AA', action: 'login' });
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, hostname: 'example.com' }) });
  await request(app).post('/api/v1/auth/login').set('X-Turnstile-Token', 'XXXX.DUMMY.TOKEN.XXXX').send(credentials).expect(200);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
