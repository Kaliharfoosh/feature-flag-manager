// Integration test against a real database: runs only when DATABASE_URL is set, e.g.
//   node --env-file=.env node_modules/jest/bin/jest.js backend/services/audit-alerts
// Each test creates its own team inside a transaction and rolls it back, so nothing is left behind
// and the seeded data is never touched.
const { Client } = require('pg');
const audit = require('../../../shared/audit');
const alerts = require('../alerts');
const query = require('../query');
const schema = require('../schema');
const github = require('../github');

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('alerts and audit queries against Postgres', () => {
  let client;
  let teamId;
  let otherTeamId;
  const req = (email, teamOfUser) => ({ id: `it-${Math.random()}`, ip: '203.0.113.9', user: { id: null, email, teamId: teamOfUser } });

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
    await require('../../../db/pool').pool.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    const make = async (name) => (await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    teamId = await make(`it-team-${Date.now()}-a`);
    otherTeamId = await make(`it-team-${Date.now()}-b`);
  });
  afterEach(() => client.query('ROLLBACK'));

  test('a prod change raises an open alert in the same transaction (AUD-20)', async () => {
    const { id, alert } = await audit.record(client, req('admin@it.test', teamId), {
      action: 'flag.toggled', targetType: 'flag', targetId: 'f1',
      before: { enabled: false }, after: { enabled: true }, details: { env: 'prod' },
    });
    expect(alert).toMatchObject({ rule: 'prod_change', status: 'open' });
    const { rows } = await client.query('SELECT audit_event_id, team_id FROM alerts WHERE id = $1', [alert.id]);
    expect(rows[0]).toEqual({ audit_event_id: String(id), team_id: teamId });
  });

  test('a staging change and a disabled rule raise nothing (AUD-18)', async () => {
    await client.query("INSERT INTO alert_rules (team_id, rule, enabled) VALUES ($1, 'key_change', false)", [teamId]);
    const staging = await audit.record(client, req('dev@it.test', teamId), { action: 'flag.toggled', details: { env: 'staging' } });
    const key = await audit.record(client, req('admin@it.test', teamId), { action: 'key.created', details: { env: 'staging', prefix: 'ffm_stg_Ab12Cd' } });
    expect(staging.alert).toBeNull();
    expect(key.alert).toBeNull();
  });

  test('login failures raise one alert when the threshold is reached', async () => {
    const results = [];
    for (let i = 0; i < alerts.LOGIN_FAILURE_THRESHOLD + 3; i += 1) {
      results.push(await audit.recordSecurity({ id: `r${i}`, ip: '203.0.113.9' }, 'login.failed', { reason: 'bad_password' }, { teamId, db: client }));
    }
    const raised = results.filter((r) => r.alert);
    expect(raised).toHaveLength(1);
    expect(results.indexOf(raised[0])).toBe(alerts.LOGIN_FAILURE_THRESHOLD - 1);
  });

  test('list, filters and paging stay inside the team (AUD-02, AUD-03, AUD-06, AUD-08)', async () => {
    for (const action of ['flag.created', 'flag.toggled', 'rollout.updated']) {
      await audit.record(client, req('dev@it.test', teamId), { action, details: { env: 'dev' } });
    }
    await audit.record(client, req('admin@other.test', otherTeamId), { action: 'flag.created' });

    const first = await query.listEvents(teamId, schema.parseAuditList({ limit: '2' }), client);
    const second = await query.listEvents(teamId, schema.parseAuditList({ limit: '2', cursor: first.nextCursor }), client);
    expect(first.items.map((e) => e.action)).toEqual(['rollout.updated', 'flag.toggled']); // newest first
    expect(second.items.map((e) => e.action)).toEqual(['flag.created']);
    expect(second.nextCursor).toBeNull();

    const byAction = await query.listEvents(teamId, schema.parseAuditList({ action: 'rollout.updated' }), client);
    expect(byAction.items).toHaveLength(1);
    const byActor = await query.listEvents(teamId, schema.parseAuditList({ actor: 'DEV@it.test' }), client);
    expect(byActor.items).toHaveLength(3);
    const otherTeam = await query.listEvents(otherTeamId, schema.parseAuditList({}), client);
    expect(otherTeam.items.map((e) => e.actorLabel)).toEqual(['admin@other.test']);

    const empty = await query.listEvents(teamId, schema.parseAuditList({ from: '2001-01-01', to: '2001-01-02' }), client);
    expect(empty).toEqual({ items: [], nextCursor: null }); // AUD-04: empty is a list, not a 404
  });

  test('summary counts match (AUD-09)', async () => {
    await audit.record(client, req('admin@it.test', teamId), { action: 'flag.toggled', details: { env: 'prod' } }); // + alert
    await audit.record(client, req('dev@it.test', teamId), { action: 'flag.toggled', details: { env: 'staging' } });
    await audit.recordSecurity({ ip: '203.0.113.9' }, 'login.failed', {}, { teamId, db: client });
    await audit.recordSecurity(req('dev@it.test', teamId), 'access.denied', { requiredRole: 'admin' }, { db: client });

    expect(await query.summary(teamId, 7, client)).toEqual({
      days: 7, changes: 2, securityEvents: 2, failedLogins: 1, prodChanges: 1, alertsOpen: 1,
    });
  });

  test('monitoring totals, top IPs and an hourly series with no holes (AUD-15)', async () => {
    for (let i = 0; i < 3; i += 1) await audit.recordSecurity({ ip: '203.0.113.9' }, 'login.failed', {}, { teamId, db: client });
    await audit.recordSecurity({ ip: '198.51.100.4' }, 'login.failed', { rateLimited: true }, { teamId, db: client });
    await audit.recordSecurity(req('dev@it.test', teamId), 'access.denied', {}, { db: client });

    const m = await query.monitoring(teamId, 24, client);
    expect(m).toMatchObject({ hours: 24, failedLogins: 4, forbidden: 1, serverErrors: 0, rateLimited: 1, alertFailures: 0 });
    expect(m.topFailedLoginIps).toEqual([{ ip: '203.0.113.9', count: 3 }, { ip: '198.51.100.4', count: 1 }]);
    expect(m.bucketMinutes).toBe(60);
    expect(m.series).toHaveLength(24);
    expect(m.series[23]).toMatchObject({ failedLogins: 4, forbidden: 1 });
  });

  test('monitoring: attacks with no team are counted, bot checks and API rate limits are charted, 7 days uses 6-hour buckets', async () => {
    const before = await query.monitoring(teamId, 168, client);
    // credential stuffing with emails that do not exist: no team
    for (let i = 0; i < 3; i += 1) await audit.recordSecurity({ ip: '203.0.113.50' }, 'login.failed', { rateLimited: false }, { teamId: null, db: client });
    await audit.recordSecurity({ ip: '203.0.113.50' }, 'bot_check.failed', { reason: 'missing_or_invalid_token' }, { teamId: null, db: client });
    // this team: a failed bot check and an API-key rate limit
    await audit.recordSecurity({ ip: '198.51.100.7' }, 'bot_check.failed', { reason: 'missing_or_invalid_token' }, { teamId, db: client });
    await audit.recordSecurity({ ip: '198.51.100.7' }, 'rate_limit.hit', { reason: 'api_key', count: 120 }, { teamId, db: client });

    const m = await query.monitoring(teamId, 168, client);
    expect(m.unattributed.failedLogins - before.unattributed.failedLogins).toBe(3);
    expect(m.unattributed.botCheckFailures - before.unattributed.botCheckFailures).toBe(1);
    expect(m.topFailedLoginIps).toEqual([]); // no-team IPs are never shown to a team
    expect(m.bucketMinutes).toBe(360);
    expect(m.series).toHaveLength(28);
    expect(new Date(m.series[1].hour) - new Date(m.series[0].hour)).toBe(6 * 3600 * 1000);
    expect(m.series[27]).toMatchObject({ botCheckFailures: 1, rateLimited: 1, failedLogins: 0 });
  });

  test('monitoring: refused endpoints, and 5-minute buckets in the 1-hour window', async () => {
    const dev = req('dev@it.test', teamId);
    for (let i = 0; i < 3; i += 1) await audit.recordSecurity(dev, 'access.denied', { method: 'GET', path: '/api/v1/monitoring' }, { db: client });
    await audit.recordSecurity(dev, 'access.denied', { method: 'GET', path: '/api/v1/audit/export.csv' }, { db: client });
    await audit.recordSecurity(req('x@other.test', otherTeamId), 'access.denied', { method: 'GET', path: '/api/v1/secret' }, { db: client });

    const m = await query.monitoring(teamId, 1, client);
    expect(m.topRefusedEndpoints).toEqual([
      { endpoint: 'GET /api/v1/monitoring', count: 3 },
      { endpoint: 'GET /api/v1/audit/export.csv', count: 1 },
    ]); // the other team's refusal is not visible here
    expect(m.bucketMinutes).toBe(5);
    expect(m.series).toHaveLength(12);
    expect(m.series[11].forbidden).toBe(4);
    const step = new Date(m.series[1].hour) - new Date(m.series[0].hour);
    expect(step).toBe(5 * 60 * 1000);
  });

  test('updating alert rules saves them and writes alert_rules.updated', async () => {
    const r = req('admin@it.test', teamId);
    await alerts.updateRules(client, r, [{ rule: 'prod_change', enabled: false }]);
    await alerts.updateRules(client, r, [{ rule: 'prod_change', enabled: true }, { rule: 'key_change', enabled: false }]);
    expect(await alerts.getRules(client, teamId)).toEqual([
      { rule: 'prod_change', enabled: true },
      { rule: 'key_change', enabled: false },
      { rule: 'login_failures', enabled: true },
    ]);
    const { items } = await query.listEvents(teamId, schema.parseAuditList({ action: 'alert_rules.updated' }), client);
    expect(items).toHaveLength(2);
    expect(items[0].details.after.rules[1]).toEqual({ rule: 'key_change', enabled: false });
  });

  test('GitHub delivery: failed, then retried to sent, against the real alerts table', async () => {
    const r = req('admin@it.test', teamId);
    const { id: auditId, alert } = await audit.record(client, r, { action: 'flag.toggled', details: { env: 'prod' } });
    expect(r.pendingAlerts).toEqual([alert.id]);
    const env = { GITHUB_TOKEN: 'test-token', GITHUB_REPO: 'o/r' };

    const down = jest.fn(async () => ({ status: 503, json: async () => ({ message: 'Service Unavailable' }) }));
    await expect(github.deliver(alert.id, { db: client, fetchImpl: down, env })).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' });
    let row = await github.findAlertForEvent(teamId, String(auditId), client);
    expect(row).toMatchObject({ status: 'failed', last_error: 'GitHub answered 503: Service Unavailable' });

    const up = jest.fn(async () => ({ status: 201, json: async () => ({ number: 5, html_url: 'https://github.com/o/r/issues/5' }) }));
    await github.deliver(alert.id, { db: client, fetchImpl: up, env });
    row = await github.findAlertForEvent(teamId, String(auditId), client);
    expect(row).toMatchObject({ status: 'sent', github_issue_number: 5, last_error: null });
    expect(JSON.parse(up.mock.calls[0][1].body).body).toContain('**Action:** `flag.toggled`');

    await expect(github.deliver(alert.id, { db: client, fetchImpl: up, env })).resolves.toBeNull(); // never twice
    expect(up).toHaveBeenCalledTimes(1);
    expect((await github.listAlerts(teamId, client))[0]).toMatchObject({ status: 'sent', githubIssueNumber: 5 });
  });

  test('daily summary: counts every team, security and production changes (scheduler job)', async () => {
    const before = await query.platformSummary(24, client);
    const r = req('admin@it.test', teamId);
    await audit.record(client, r, { action: 'flag.toggled', details: { env: 'prod' } }); // + alert
    await audit.record(client, req('dev@it.test', otherTeamId), { action: 'rollout.updated', details: { env: 'staging' } });
    await audit.record(client, r, { category: 'security', action: 'login.failed', details: { rateLimited: true } });
    await audit.record(client, r, { category: 'security', action: 'access.denied' });
    const after = await query.platformSummary(24, client);
    const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));
    expect(delta).toMatchObject({
      changes: 2, prodChanges: 1, failedLogins: 1, rateLimited: 1, forbidden: 1, serverErrors: 0, alertsRaised: 1,
    });
  });

  test('sweeper: finds alerts left "open" or stuck in "sending", never "failed" or new ones', async () => {
    const r = req('admin@it.test', teamId);
    const raise = async () => (await audit.record(client, r, { action: 'flag.toggled', details: { env: 'prod' } })).alert.id;
    const oldOpen = await raise();
    const newOpen = await raise();
    const oldSending = await raise();
    const oldFailed = await raise();
    await client.query("UPDATE alerts SET created_at = now() - interval '10 minutes' WHERE id = ANY($1::uuid[])", [[oldOpen, oldSending, oldFailed]]);
    await client.query("UPDATE alerts SET status = 'sending', updated_at = now() - interval '10 minutes' WHERE id = $1", [oldSending]);
    await client.query("UPDATE alerts SET status = 'failed' WHERE id = $1", [oldFailed]);
    const ids = await github.stuckAlertIds(500, client);
    expect(ids).toEqual(expect.arrayContaining([oldOpen, oldSending]));
    expect(ids).not.toContain(newOpen);
    expect(ids).not.toContain(oldFailed);
  });

  test('export returns the same filtered events as the list', async () => {
    await audit.record(client, req('dev@it.test', teamId), { action: 'flag.created', details: { name: '=HYPERLINK("x")' } });
    const events = await query.exportEvents(teamId, schema.parseAuditExport({ category: 'change' }), client);
    expect(events).toHaveLength(1);
    expect(events[0].details).toEqual({ name: '=HYPERLINK("x")' });
  });
});
