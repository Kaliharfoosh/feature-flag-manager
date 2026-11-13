const bcrypt = require('bcryptjs');
const request = require('supertest');

jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../../db/pool', () => ({
  pool: { connect: jest.fn(), query: jest.fn() },
}));

process.env.SESSION_SECRET = 'session-secret-for-auth-tests';
process.env.LOG_LEVEL = 'silent';

const app = require('../../../app');
const { pool } = require('../../../db/pool');

const user = {
  id: 'c72f08c0-3a44-4f92-8379-0375da225f99',
  email: 'admin@acme.test',
  name: 'Amira Admin',
  role: 'admin',
  teamId: '699df5c7-e092-4a81-b7cb-14d6ea382378',
};
const password = 'demo-password-for-tests';
const auth = '/api/v1/auth';

let passwordHash;
const transaction = { query: jest.fn(), release: jest.fn() };

beforeAll(async () => {
  passwordHash = await bcrypt.hash(password, 12);
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.connect.mockResolvedValue(transaction);
  pool.query.mockImplementation(async (sql, [id]) => ({
    rows: id === user.id ? [user] : [],
  }));
  transaction.query.mockImplementation(async (sql, [value] = []) => {
    if (sql.includes('AS blocked')) {
      return { rows: [{ blocked: false }] };
    }
    if (sql.includes('lower(email)') && value === user.email) {
      return { rows: [{ ...user, passwordHash }] };
    }
    return { rows: [] };
  });
});

test('signs in, restores the current user, and signs out with a CSRF token', async () => {
  const browser = request.agent(app);
  await browser.get(`${auth}/me`).expect(401);

  const login = await browser.post(`${auth}/login`)
    .send({ email: '  ADMIN@ACME.TEST  ', password })
    .expect(200, { user })
    .expect('Cache-Control', 'no-store');
  const [cookie] = login.headers['set-cookie'];
  expect(cookie).toMatch(/^ffm\.sid=/);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');

  const current = await browser.get(`${auth}/me`).expect(200);
  expect(current.body).toEqual({ user, csrfToken: expect.any(String) });
  const missing = await browser.post(`${auth}/logout`).expect(403);
  expect(missing.body.error.code).toBe('CSRF_INVALID');

  await browser.post(`${auth}/logout`)
    .set('X-CSRF-Token', current.body.csrfToken)
    .expect(204);

  await request(app).get(`${auth}/me`).set('Cookie', cookie.split(';')[0]).expect(401);
});

test('rotates both session and CSRF token when an existing user signs in again', async () => {
  const browser = request.agent(app);
  const credentials = { email: user.email, password };
  const firstLogin = await browser.post(`${auth}/login`).send(credentials).expect(200);
  const firstSession = firstLogin.headers['set-cookie'][0].split(';')[0];
  const firstMe = await browser.get(`${auth}/me`).expect(200);

  const secondLogin = await browser.post(`${auth}/login`).send(credentials).expect(200);
  expect(secondLogin.headers['set-cookie'][0].split(';')[0]).not.toBe(firstSession);
  await request(app).get(`${auth}/me`).set('Cookie', firstSession).expect(401);
  await browser.post(`${auth}/logout`)
    .set('X-CSRF-Token', firstMe.body.csrfToken)
    .expect(403);
});

test('returns the same error for wrong passwords and unknown emails', async () => {
  const invalidPassword = await request(app).post(`${auth}/login`)
    .send({ email: user.email, password: 'wrong-password' }).expect(401);
  const unknownEmail = await request(app).post(`${auth}/login`)
    .send({ email: 'unknown@acme.test', password: 'wrong-password' }).expect(401);

  for (const response of [invalidPassword, unknownEmail]) {
    expect(response.body.error).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Invalid email or password.',
      requestId: expect.any(String),
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  }
});

test('names the invalid field in the validation response', async () => {
  const response = await request(app).post(`${auth}/login`).send({ email: 5 }).expect(400);
  expect(response.body.error.code).toBe('VALIDATION_ERROR');
  expect(response.body.error.message).toMatch(/^email:/);
});

test('rejects a non-JSON request with a payload', async () => {
  const response = await request(app).post(`${auth}/login`)
    .type('text').send('credentials').expect(415);
  expect(response.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
});

test('audits failed and throttled sign-ins without storing the submitted credentials', async () => {
  const wrongPassword = 'wrong-password';
  const denied = await request(app).post(`${auth}/login`)
    .send({ email: user.email, password: wrongPassword }).expect(401);
  const calls = transaction.query.mock.calls;
  const [attemptSql, [emailHash, ip, success]] = calls.find(([sql]) => sql.includes('INSERT INTO login_attempts'));
  expect(attemptSql).toContain('email_hash');
  expect(emailHash).toMatch(/^[a-f0-9]{64}$/);
  expect(success).toBe(false);
  const [auditSql, auditArgs] = calls.find(([sql]) => sql.includes('INSERT INTO audit_events'));
  expect(auditSql).toContain("'security', 'login.failed'");
  expect(auditArgs).toEqual([user.teamId, denied.headers['x-request-id'], ip, { rateLimited: false }]);
  expect(JSON.stringify(calls.filter(([sql]) => sql.includes('INSERT')))).not.toContain(wrongPassword);

  transaction.query.mockClear();
  const query = transaction.query.getMockImplementation();
  transaction.query.mockImplementation(async (sql, params) => {
    if (sql.includes('AS blocked')) {
      return { rows: [{ blocked: true }] };
    }
    return query(sql, params);
  });

  const blocked = await request(app).post(`${auth}/login`)
    .send({ email: user.email, password }).expect(429);
  expect(blocked.body.error.code).toBe('RATE_LIMITED');
  expect(blocked.headers['set-cookie']).toBeUndefined();
  expect(transaction.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO login_attempts'))).toBe(false);
  const [, blockedAudit] = transaction.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_events'));
  expect(blockedAudit).toEqual([user.teamId, blocked.headers['x-request-id'], ip, { rateLimited: true }]);
  expect(transaction.query).toHaveBeenLastCalledWith('COMMIT');
});

test('rolls back the login attempt if writing the audit event fails', async () => {
  const query = transaction.query.getMockImplementation();
  transaction.query.mockImplementation(async (sql, params) => {
    if (sql.includes('INSERT INTO audit_events')) {
      throw new Error('Audit insert failed');
    }
    return query(sql, params);
  });

  await request(app).post(`${auth}/login`)
    .send({ email: user.email, password: 'wrong-password' }).expect(500);
  expect(transaction.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(transaction.release).toHaveBeenCalledTimes(1);
});
