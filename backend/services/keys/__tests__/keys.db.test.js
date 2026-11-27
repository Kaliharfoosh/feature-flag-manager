// Real SQL and the actual Express routes. Each fixture is rolled back, including audit/alerts.
jest.mock('../../../middleware/turnstile', () => ({
  ...jest.requireActual('../../../middleware/turnstile'), verifyTurnstile: jest.fn(),
}));
jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../../audit-alerts/github', () => ({
  ...jest.requireActual('../../audit-alerts/github'), deliverPending: jest.fn(),
}));

process.env.SESSION_SECRET = 'keys-db-tests-only';
process.env.LOG_LEVEL = 'silent';
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const app = require('../../../app');
const { pool } = require('../../../db/pool');
const auth = require('../../auth/service');
const audit = require('../../../shared/audit');
const github = require('../../audit-alerts/github');
const { hashKey } = require('../../../shared/api-keys');
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const url = '/api/v1/keys';

describeDb('API key lifecycle against PostgreSQL', () => {
  let client, querySpy, connectSpy, user, agent, csrf;
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    querySpy = jest.spyOn(pool, 'query').mockImplementation((sql, params) => client.query(sql, params));
    connectSpy = jest.spyOn(pool, 'connect').mockResolvedValue({
      query: (sql, params) => client.query({
        BEGIN: 'SAVEPOINT keys_test', COMMIT: 'RELEASE SAVEPOINT keys_test', ROLLBACK: 'ROLLBACK TO SAVEPOINT keys_test',
      }[sql] ?? sql, params),
      release: () => {},
    });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    await client.query('BEGIN');
    const { rows: [team] } = await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', ['keys-' + randomUUID()]);
    ({ rows: [user] } = await client.query(
      `INSERT INTO users (team_id, email, name, password_hash, role)
       VALUES ($1, $2, 'Key Admin', 'unused', 'admin') RETURNING id, email, role, team_id AS "teamId"`,
      [team.id, `${randomUUID()}@keys.test`],
    ));
    auth.authenticate.mockResolvedValue({ user, rateLimited: false });
    auth.findById.mockResolvedValue(user);
    agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ email: user.email, password: 'unused-password' }).expect(200);
    csrf = (await agent.get('/api/v1/auth/me').expect(200)).body.csrfToken;
    // A real flag with deliberately different values across environments.
    const { rows: [flag] } = await client.query(
      `INSERT INTO flags (team_id, key, name, created_by) VALUES ($1, 'key-scope-test', 'Scope test', $2) RETURNING id`,
      [user.teamId, user.id],
    );
    for (const env of ['dev', 'staging', 'prod']) {
      await client.query('INSERT INTO flag_environments (flag_id, env, enabled) VALUES ($1, $2, $3)', [flag.id, env, env === 'prod']);
      await client.query('INSERT INTO rollouts (flag_id, env, percentage) VALUES ($1, $2, 100)', [flag.id, env]);
    }
  });
  afterEach(async () => { audit.record.mockRestore?.(); await client.query('ROLLBACK'); });
  afterAll(async () => { querySpy?.mockRestore(); connectSpy?.mockRestore(); await client?.end(); await pool.end(); });

  async function create(env = 'staging', name = 'Storefront') {
    return (await agent.post(url).set('X-CSRF-Token', csrf).send({ name, env }).expect(201)).body;
  }
  const evaluate = (key, batch = false) => request(app).post(`/api/v1/evaluations${batch ? '/batch' : ''}`)
    .set('Authorization', `Bearer ${key}`).send(batch ? { flagKeys: ['key-scope-test'], userId: 'u-1' } : { flagKey: 'key-scope-test', userId: 'u-1' });

  test.each(['dev', 'staging', 'prod'])('%s: create → evaluate → revoke → 401 (ST-07)', async (env) => {
    const response = await agent.post(url).set('X-CSRF-Token', csrf).send({ name: '  Storefront  ', env }).expect(201);
    const key = response.body;
    expect(response.headers['cache-control']).toBe('no-store');
    expect(key.name).toBe('Storefront');
    expect(key.key).toMatch(/^ffm_(dev|stg|prd)_[A-Za-z0-9_-]{32}$/);
    expect((await evaluate(key.key).expect(200)).body).toMatchObject({ env, enabled: env === 'prod' });
    expect((await evaluate(key.key, true).expect(200)).body.flags['key-scope-test']).toBe(env === 'prod');
    await agent.delete(`${url}/${key.id}`).set('X-CSRF-Token', csrf).expect(204);
    await evaluate(key.key).expect(401);
    await evaluate(key.key, true).expect(401);
    const { rows } = await client.query("SELECT action, details FROM audit_events WHERE target_id = $1 AND category = 'change' ORDER BY id", [key.id]);
    expect(rows.map((r) => r.action)).toEqual(['key.created', 'key.revoked']);
    expect(JSON.stringify(rows)).not.toContain(key.key);
    const { rows: alerts } = await client.query("SELECT rule FROM alerts WHERE team_id = $1 AND rule = 'key_change'", [user.teamId]);
    expect(alerts).toHaveLength(2);
    expect(github.deliverPending).toHaveBeenCalled();
  });

  test('only the hash is stored; lists never expose a raw key or hash', async () => {
    const key = await create();
    const { rows: [stored] } = await client.query('SELECT * FROM api_keys WHERE id = $1', [key.id]);
    expect(stored.key_hash).toBe(hashKey(key.key));
    expect(JSON.stringify(stored)).not.toContain(key.key);
    const result = await agent.get(url).expect(200);
    expect(result.body.items[0]).toMatchObject({ id: key.id, prefix: key.prefix, revokedAt: null });
    expect(JSON.stringify(result.body)).not.toContain(key.key);
    expect(JSON.stringify(result.body)).not.toContain(stored.key_hash);
    expect(Object.keys(result.body.items[0]).sort()).toEqual(['createdAt', 'env', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt']);
  });

  test('another team can neither list nor revoke a key; unknown ids look identical', async () => {
    const key = await create();
    const { rows: [foreign] } = await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', ['foreign-' + randomUUID()]);
    auth.findById.mockResolvedValue({ ...user, teamId: foreign.id });
    expect((await agent.get(url).expect(200)).body.items).toEqual([]);
    const foreignResponse = await agent.delete(`${url}/${key.id}`).set('X-CSRF-Token', csrf).expect(404);
    const missingResponse = await agent.delete(`${url}/${randomUUID()}`).set('X-CSRF-Token', csrf).expect(404);
    expect(foreignResponse.body.error.message).toBe(missingResponse.body.error.message);
    expect((await client.query('SELECT revoked_at FROM api_keys WHERE id = $1', [key.id])).rows[0].revoked_at).toBeNull();
  });

  test('a repeated revoke is safe and does not duplicate its audit or alert', async () => {
    const key = await create();
    for (let i = 0; i < 2; i++) await agent.delete(`${url}/${key.id}`).set('X-CSRF-Token', csrf).expect(204);
    const { rows } = await client.query("SELECT id FROM audit_events WHERE action = 'key.revoked' AND target_id = $1", [key.id]);
    expect(rows).toHaveLength(1);
    const items = (await agent.get(url).expect(200)).body.items;
    expect(items.find((item) => item.id === key.id).revokedAt).toBeTruthy();
  });

  test('create rolls back if the audit insert fails', async () => {
    jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await agent.post(url).set('X-CSRF-Token', csrf).send({ name: 'Must roll back', env: 'dev' }).expect(500);
    expect((await client.query('SELECT id FROM api_keys WHERE team_id = $1', [user.teamId])).rows).toHaveLength(0);
  });

  test('revoke rolls back if the audit insert fails', async () => {
    const key = await create();
    jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await agent.delete(`${url}/${key.id}`).set('X-CSRF-Token', csrf).expect(500);
    expect((await client.query('SELECT revoked_at FROM api_keys WHERE id = $1', [key.id])).rows[0].revoked_at).toBeNull();
    await evaluate(key.key).expect(200);
  });
});

