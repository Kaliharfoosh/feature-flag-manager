// Integration test against a real database: runs only when DATABASE_URL is set, e.g.
//   node --env-file=.env node_modules/jest/bin/jest.js backend/services/audit-alerts
// Each test creates its own team inside a transaction and rolls it back, so nothing is left behind
// and the seeded data is never touched.
const { Client } = require('pg');
const audit = require('../../../shared/audit');
const alerts = require('../alerts');
const query = require('../query');
const schema = require('../schema');

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
    await audit.recordSecurity({ ip: '198.51.100.4' }, 'login.failed', {}, { teamId, db: client });
    await audit.recordSecurity(req('dev@it.test', teamId), 'access.denied', {}, { db: client });

    const m = await query.monitoring(teamId, 24, client);
    expect(m).toMatchObject({ hours: 24, failedLogins: 4, forbidden: 1, serverErrors: 0, rateLimited: 0, alertFailures: 0 });
    expect(m.topFailedLoginIps).toEqual([{ ip: '203.0.113.9', count: 3 }, { ip: '198.51.100.4', count: 1 }]);
    expect(m.series).toHaveLength(24);
    expect(m.series[23]).toMatchObject({ failedLogins: 4, forbidden: 1 });
  });

  test('export returns the same filtered events as the list', async () => {
    await audit.record(client, req('dev@it.test', teamId), { action: 'flag.created', details: { name: '=HYPERLINK("x")' } });
    const events = await query.exportEvents(teamId, schema.parseAuditExport({ category: 'change' }), client);
    expect(events).toHaveLength(1);
    expect(events[0].details).toEqual({ name: '=HYPERLINK("x")' });
  });
});
