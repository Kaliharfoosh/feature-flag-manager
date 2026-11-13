// Route tests through the real Express app: real sessions, CSRF, requireAuth and requireRole.
// The database, the login check and the SQL layer are mocked; query.js has its own tests.
const request = require('supertest');

jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../../db/pool', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../../auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../query');
jest.mock('../github', () => ({
  ...jest.requireActual('../github'),
  deliver: jest.fn(), deliverPending: jest.fn(), findAlertForEvent: jest.fn(), listAlerts: jest.fn(),
}));

process.env.SESSION_SECRET = 'session-secret-for-audit-tests';
process.env.LOG_LEVEL = 'silent';

const app = require('../../../app');
const { pool } = require('../../../db/pool');
const authService = require('../../auth/service');
const query = require('../query');
const github = require('../github');

const teamId = '699df5c7-e092-4a81-b7cb-14d6ea382378';
const users = {
  admin: { id: 'c72f08c0-3a44-4f92-8379-0375da225f99', email: 'admin@acme.test', name: 'Amira Admin', role: 'admin', teamId },
  developer: { id: 'd1e2f3a4-0000-4000-8000-000000000002', email: 'dev@acme.test', name: 'Dina Developer', role: 'developer', teamId },
};
const api = '/api/v1';
const tx = { query: jest.fn(), release: jest.fn() };

// Every INSERT ... RETURNING gets an id; alert_rules reads return what the test stored.
let storedRules;
function fakeQuery(sql, params = []) {
  if (sql.startsWith('INSERT INTO audit_events')) return { rows: [{ id: '77', at: new Date() }] };
  if (sql.startsWith('SELECT rule, enabled FROM alert_rules')) return { rows: storedRules };
  if (sql.includes('INSERT INTO alert_rules')) {
    storedRules = storedRules.filter((r) => r.rule !== params[1]).concat({ rule: params[1], enabled: params[2] });
  }
  return { rows: [] };
}
const insertedActions = (mock) => mock.mock.calls
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
  storedRules = [{ rule: 'prod_change', enabled: true }];
  authService.findById.mockImplementation(async (id) => Object.values(users).find((u) => u.id === id));
  pool.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  pool.connect.mockResolvedValue(tx);
  tx.query.mockImplementation(async (sql, params) => fakeQuery(sql, params));
  query.listEvents.mockResolvedValue({ items: [], nextCursor: null });
  query.summary.mockResolvedValue({ days: 7, changes: 0, securityEvents: 0, failedLogins: 0, prodChanges: 0, alertsOpen: 0 });
  query.monitoring.mockResolvedValue({ hours: 24, failedLogins: 0 });
  query.exportEvents.mockResolvedValue([]);
});

describe('GET /audit', () => {
  test('401 without a session (AUD-07)', async () => {
    const res = await request(app).get(`${api}/audit`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('a Developer reads their own team, newest first, never cached (AUD-01)', async () => {
    const { agent } = await signIn('developer');
    const res = await agent.get(`${api}/audit?action=flag.toggled&limit=10`)
      .expect(200, { items: [], nextCursor: null })
      .expect('Cache-Control', 'no-store');
    expect(query.listEvents).toHaveBeenCalledWith(teamId, { action: 'flag.toggled', limit: 10 });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  test('400 for a bad date (AUD-05)', async () => {
    const { agent } = await signIn('developer');
    const res = await agent.get(`${api}/audit?from=yesterday`).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/^from/) });
  });

  test('the client cannot choose the team (AUD-08)', async () => {
    const { agent } = await signIn('admin');
    await agent.get(`${api}/audit?team_id=someone-else`).expect(400);
    expect(query.listEvents).not.toHaveBeenCalled();
  });
});

describe('GET /audit/summary', () => {
  test('200 with the counts (AUD-09)', async () => {
    const { agent } = await signIn('developer');
    await agent.get(`${api}/audit/summary?days=30`).expect(200);
    expect(query.summary).toHaveBeenCalledWith(teamId, 30);
  });

  test('400 for days=0 (AUD-10)', async () => {
    const { agent } = await signIn('developer');
    await agent.get(`${api}/audit/summary?days=0`).expect(400);
  });
});

describe('GET /audit/export.csv', () => {
  test('an Admin downloads a CSV with formulas neutralised (AUD-11, ST-17)', async () => {
    query.exportEvents.mockResolvedValue([{
      at: new Date('2026-11-13T14:05:00.000Z'), actorLabel: 'admin@acme.test', category: 'change',
      action: 'flag.created', targetType: 'flag', targetId: 'f1', requestId: 'r1',
      details: { after: { name: '=HYPERLINK("http://example.com","click")' } },
    }]);
    const { agent } = await signIn('admin');
    const res = await agent.get(`${api}/audit/export.csv?from=2026-11-01&to=2026-11-13`).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="audit-2026-11-01-2026-11-13.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.split('\r\n')[0]).toBe('at,actor,category,action,targetType,targetId,requestId,details');
    expect(res.text).toContain('"flag.created"');
  });

  test('a Developer gets 403 and the refusal is recorded (AUD-12, ST-12)', async () => {
    const { agent } = await signIn('developer');
    const res = await agent.get(`${api}/audit/export.csv`).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(query.exportEvents).not.toHaveBeenCalled();
    expect(insertedActions(pool.query)).toEqual(['access.denied']);
    const [, params] = pool.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO audit_events'));
    expect(params.slice(0, 4)).toEqual([teamId, users.developer.id, 'dev@acme.test', 'security']);
    expect(JSON.parse(params[7])).toEqual({ method: 'GET', path: '/api/v1/audit/export.csv', requiredRole: 'admin' });
  });
});

describe('GET /monitoring', () => {
  test('Admin only (AUD-16)', async () => {
    const dev = await signIn('developer');
    await dev.agent.get(`${api}/monitoring`).expect(403);
    const admin = await signIn('admin');
    await admin.agent.get(`${api}/monitoring?hours=6`).expect(200);
    expect(query.monitoring).toHaveBeenCalledWith(teamId, 6);
  });

  test('400 for hours=1000 (AUD-17)', async () => {
    const { agent } = await signIn('admin');
    await agent.get(`${api}/monitoring?hours=1000`).expect(400);
  });
});

describe('alert rules', () => {
  test('GET lists all three rules, missing ones as enabled', async () => {
    storedRules = [{ rule: 'login_failures', enabled: false }];
    const { agent } = await signIn('admin');
    await agent.get(`${api}/alert-rules`).expect(200, { rules: [
      { rule: 'prod_change', enabled: true },
      { rule: 'key_change', enabled: true },
      { rule: 'login_failures', enabled: false },
    ] });
  });

  test('PUT needs the CSRF token', async () => {
    const { agent } = await signIn('admin');
    const res = await agent.put(`${api}/alert-rules`).send({ rules: [{ rule: 'prod_change', enabled: false }] }).expect(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('PUT saves the change and its audit row in one transaction (AUD-18)', async () => {
    const { agent, csrf } = await signIn('admin');
    await agent.put(`${api}/alert-rules`).set('X-CSRF-Token', csrf)
      .send({ rules: [{ rule: 'prod_change', enabled: false }] })
      .expect(200, { rules: [
        { rule: 'prod_change', enabled: false },
        { rule: 'key_change', enabled: true },
        { rule: 'login_failures', enabled: true },
      ] });
    const sqls = tx.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(insertedActions(tx.query)).toEqual(['alert_rules.updated']);
    expect(tx.release).toHaveBeenCalledTimes(1);
  });

  test('PUT with an unknown rule is 400 (AUD-19)', async () => {
    const { agent, csrf } = await signIn('admin');
    const res = await agent.put(`${api}/alert-rules`).set('X-CSRF-Token', csrf)
      .send({ rules: [{ rule: 'unknown', enabled: true }] }).expect(400);
    expect(res.body.error.message).toMatch(/^rules\.0\.rule/);
  });

  test('PUT by a Developer is 403', async () => {
    const { agent, csrf } = await signIn('developer');
    await agent.put(`${api}/alert-rules`).set('X-CSRF-Token', csrf)
      .send({ rules: [{ rule: 'prod_change', enabled: false }] }).expect(403);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('a failed audit insert rolls the rule change back', async () => {
    tx.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO audit_events')) throw new Error('permission denied');
      return fakeQuery(sql, params);
    });
    const { agent, csrf } = await signIn('admin');
    await agent.put(`${api}/alert-rules`).set('X-CSRF-Token', csrf)
      .send({ rules: [{ rule: 'key_change', enabled: false }] }).expect(500);
    expect(tx.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(tx.release).toHaveBeenCalledTimes(1);
  });
});

describe('POST /alerts/:auditId/github-issue', () => {
  const alertRow = (status, extra = {}) => ({
    id: 'al1', team_id: teamId, audit_event_id: '1042', rule: 'prod_change', title: 'Prod change',
    status, github_issue_number: null, github_issue_url: null, last_error: null, created_at: new Date('2026-11-13T14:05:00Z'), ...extra,
  });
  const url = `${api}/alerts/1042/github-issue`;

  test('201 with the issue number, and the request is audited (AUD-21)', async () => {
    github.findAlertForEvent.mockResolvedValue(alertRow('failed', { last_error: 'GitHub answered 401' }));
    github.deliver.mockResolvedValue(alertRow('sent', { github_issue_number: 17, github_issue_url: 'https://github.com/o/r/issues/17' }));
    const { agent, csrf } = await signIn('admin');
    const res = await agent.post(url).set('X-CSRF-Token', csrf).expect(201);
    expect(res.body).toMatchObject({ alertId: 'al1', auditEventId: 1042, status: 'sent', githubIssueNumber: 17, githubIssueUrl: 'https://github.com/o/r/issues/17' });
    expect(github.findAlertForEvent).toHaveBeenCalledWith(teamId, '1042');
    expect(insertedActions(pool.query)).toEqual(['alert.issue_requested']);
  });

  test('already sent: 200 with the existing issue, GitHub not called again', async () => {
    github.findAlertForEvent.mockResolvedValue(alertRow('sent', { github_issue_number: 17 }));
    const { agent, csrf } = await signIn('admin');
    const res = await agent.post(url).set('X-CSRF-Token', csrf).expect(200);
    expect(res.body.githubIssueNumber).toBe(17);
    expect(github.deliver).not.toHaveBeenCalled();
  });

  test('GitHub failing is 502 UPSTREAM_FAILED and still audited (AUD-22)', async () => {
    github.findAlertForEvent.mockResolvedValue(alertRow('open'));
    github.deliver.mockRejectedValue(Object.assign(new Error('GitHub answered 401: Bad credentials'), { status: 502, code: 'UPSTREAM_FAILED' }));
    const { agent, csrf } = await signIn('admin');
    const res = await agent.post(url).set('X-CSRF-Token', csrf).expect(502);
    expect(res.body.error).toMatchObject({ code: 'UPSTREAM_FAILED', message: 'GitHub answered 401: Bad credentials' });
    const [, params] = pool.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO audit_events'));
    expect(JSON.parse(params[7])).toEqual({ rule: 'prod_change', status: 'failed' });
  });

  test('already being sent is 409', async () => {
    github.findAlertForEvent.mockResolvedValue(alertRow('sending'));
    github.deliver.mockResolvedValue(null);
    const { agent, csrf } = await signIn('admin');
    const res = await agent.post(url).set('X-CSRF-Token', csrf).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  test('no alert for that id (or another team\'s) is 404 (AUD-24)', async () => {
    github.findAlertForEvent.mockResolvedValue(null);
    const { agent, csrf } = await signIn('admin');
    await agent.post(`${api}/alerts/999999/github-issue`).set('X-CSRF-Token', csrf).expect(404);
  });

  test('a non-numeric id is 400', async () => {
    const { agent, csrf } = await signIn('admin');
    await agent.post(`${api}/alerts/1%20OR%201=1/github-issue`).set('X-CSRF-Token', csrf).expect(400);
    expect(github.findAlertForEvent).not.toHaveBeenCalled();
  });

  test('Developer 403 (AUD-23), missing CSRF 403', async () => {
    const dev = await signIn('developer');
    await dev.agent.post(url).set('X-CSRF-Token', dev.csrf).expect(403);
    const admin = await signIn('admin');
    const res = await admin.agent.post(url).expect(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
    expect(github.deliver).not.toHaveBeenCalled();
  });

  test('GET /alerts lists the team\'s alerts for Admins', async () => {
    github.listAlerts.mockResolvedValue([]);
    const { agent } = await signIn('admin');
    await agent.get(`${api}/alerts`).expect(200, { items: [] });
    expect(github.listAlerts).toHaveBeenCalledWith(teamId);
  });
});

describe('shared behaviour', () => {
  test('an unknown /api/v1 path is still 404, not 401', async () => {
    const res = await request(app).get(`${api}/no-such-route`).expect(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  test('a 500 is recorded as a server.error security event and leaks nothing', async () => {
    query.listEvents.mockRejectedValue(new Error('connection terminated: secret-host.neon.tech'));
    const { agent } = await signIn('admin');
    const res = await agent.get(`${api}/audit`).expect(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.', requestId: expect.any(String) });
    expect(res.text).not.toContain('neon');
    expect(insertedActions(pool.query)).toContain('server.error');
  });
});
