jest.mock('../../../middleware/turnstile', () => ({ ...jest.requireActual('../../../middleware/turnstile'), verifyTurnstile: jest.fn() }));
jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../../auth/service', () => ({ authenticate: jest.fn(), findById: jest.fn() }));
jest.mock('../../audit-alerts/github', () => ({ ...jest.requireActual('../../audit-alerts/github'), deliverPending: jest.fn() }));
jest.mock('../../../shared/snapshots', () => ({ ...jest.requireActual('../../../shared/snapshots'), save: jest.fn(), read: jest.fn(), history: jest.fn(), catalog: jest.fn() }));
jest.mock('../../../shared/events', () => ({ enabled: jest.fn(), publish: jest.fn() }));
process.env.SESSION_SECRET = 's1-recovery-tests-only';
process.env.LOG_LEVEL = 'silent';
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { pool } = require('../../../db/pool');
const app = require('../../../app');
const auth = require('../../auth/service');
const snapshots = require('../../../shared/snapshots');
const events = require('../../../shared/events');
const audit = require('../../../shared/audit');
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('S1 history and recovery with real PostgreSQL', () => {
  let client, querySpy, connectSpy, user, agent, csrf, records, committed;
  const originals = { bucket: process.env.SNAPSHOT_BUCKET, key: process.env.SNAPSHOT_KMS_KEY };
  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
    querySpy = jest.spyOn(pool, 'query').mockImplementation((sql, params) => client.query(sql, params));
    connectSpy = jest.spyOn(pool, 'connect').mockResolvedValue({
      query: async (sql, params) => {
        if (sql === 'BEGIN') committed = false;
        const result = await client.query({ BEGIN: 'SAVEPOINT recovery_test', COMMIT: 'RELEASE SAVEPOINT recovery_test', ROLLBACK: 'ROLLBACK TO SAVEPOINT recovery_test' }[sql] ?? sql, params);
        if (sql === 'COMMIT') committed = true;
        return result;
      }, release: () => {},
    });
  });
  beforeEach(async () => {
    jest.clearAllMocks(); records = new Map();
    process.env.SNAPSHOT_BUCKET = 's1-test-bucket'; process.env.SNAPSHOT_KMS_KEY = 'alias/s1-test';
    await client.query('BEGIN');
    const { rows: [team] } = await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', ['recovery-' + randomUUID()]);
    ({ rows: [user] } = await client.query(`INSERT INTO users (team_id, email, name, password_hash, role) VALUES ($1, $2, 'S1 Admin', 'unused', 'admin')
      RETURNING id, email, role, team_id AS "teamId"`, [team.id, `${randomUUID()}@recovery.test`]));
    auth.authenticate.mockResolvedValue({ user, rateLimited: false }); auth.findById.mockResolvedValue(user);
    snapshots.save.mockImplementation(async data => { expect(committed).toBe(true); const versionId = 'v' + (records.size + 1); records.set(versionId, structuredClone(data)); return versionId; });
    snapshots.read.mockImplementation(async (teamId, flagId, versionId) => {
      const data = records.get(versionId) ?? (versionId ? null : [...records.values()].findLast(item => item.teamId === teamId && item.flag.id === flagId));
      if (!data || data.teamId !== teamId || data.flag.id !== flagId) throw Object.assign(new Error('Version not found.'), { status: 404, code: 'NOT_FOUND' });
      return { versionId, data };
    });
    snapshots.history.mockImplementation(async (teamId, flagId) => ({ enabled: true, items: [...records].filter(([,data]) => data.teamId === teamId && data.flag.id === flagId)
      .map(([versionId,data]) => ({ versionId, at: data.at, version: data.flag.version, actor: data.actor.email, action: data.action, name: data.flag.name, environments: data.flag.environments })), nextCursor: null }));
    snapshots.catalog.mockImplementation(async teamId => {
      const latest = new Map(); for (const [versionId,data] of records) if (data.teamId === teamId) latest.set(data.flag.id, { versionId, data });
      return { records: [...latest.values()], nextCursor: null };
    });
    agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ email: user.email, password: 'unused-password' }).expect(200);
    csrf = (await agent.get('/api/v1/auth/me').expect(200)).body.csrfToken;
  });
  afterEach(async () => { audit.record.mockRestore?.(); await client.query('ROLLBACK'); });
  afterAll(async () => { querySpy.mockRestore(); connectSpy.mockRestore(); await client.end(); await pool.end();
    for (const [name, value] of [['SNAPSHOT_BUCKET', originals.bucket], ['SNAPSHOT_KMS_KEY', originals.key]]) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const create = async (key = 'recovery-demo') => (await agent.post('/api/v1/flags').set('X-CSRF-Token', csrf).send({ key, name: 'Original flag' }).expect(201)).body;
  const edit = async (flag, body) => (await agent.patch(`/api/v1/flags/${flag.id}`).set('X-CSRF-Token', csrf).send({ version: flag.version, ...body }).expect(200)).body;
  const restore = (flagId, versionId, version) => agent.post(`/api/v1/flags/${flagId}/restore`).set('X-CSRF-Token', csrf).send({ versionId, version });

  test('captures committed state, preserves encrypted-history boundaries, restores metadata/settings/rules and audits', async () => {
    let flag = await create();
    await client.query("UPDATE rollouts SET percentage = 23.5 WHERE flag_id = $1 AND env = 'staging'", [flag.id]);
    await client.query("UPDATE flag_environments SET enabled = true WHERE flag_id = $1 AND env = 'staging'", [flag.id]);
    await client.query("INSERT INTO user_rules (flag_id, env, user_id, kind) VALUES ($1, 'staging', 'beta-1', 'allow')", [flag.id]);
    flag = await edit(flag, { name: 'Saved configuration' });
    const selectedVersion = 'v2';
    flag = await edit(flag, { name: 'Later configuration' });
    await client.query('DELETE FROM user_rules WHERE flag_id = $1', [flag.id]);
    const response = await restore(flag.id, selectedVersion, flag.version).expect(200);
    expect(response.body).toMatchObject({ id: flag.id, name: 'Saved configuration', version: 4 });
    expect(response.body.environments.staging).toMatchObject({ enabled: true, percentage: 23.5 });
    expect((await client.query('SELECT user_id, kind FROM user_rules WHERE flag_id = $1', [flag.id])).rows).toEqual([{ user_id: 'beta-1', kind: 'allow' }]);
    expect((await client.query("SELECT action FROM audit_events WHERE target_id = $1 AND action = 'flag.restored'", [flag.id])).rows).toHaveLength(1);
    expect(snapshots.save.mock.calls.at(-1)[0].action).toBe('flag.restored');
    expect(events.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'flag.restored', env: 'prod' }));
    const history = await agent.get(`/api/v1/flags/${flag.id}/history`).expect(200);
    expect(history.headers['cache-control']).toBe('no-store');
    expect(history.body.items).toHaveLength(4);
  });

  test('deleted flags remain discoverable by their own team and recover as archived', async () => {
    let flag = await create(); flag = await edit(flag, { archived: true });
    await agent.delete(`/api/v1/flags/${flag.id}`).set('X-CSRF-Token', csrf).expect(204);
    const recovery = await agent.get('/api/v1/flags/recovery').expect(200);
    expect(recovery.body.items.map(item => item.flagId)).toEqual([flag.id]);
    const response = await restore(flag.id, 'v1', null).expect(200);
    expect(response.body).toMatchObject({ id: flag.id, key: flag.key, archived: true });
    expect(response.body.version).toBeGreaterThan(flag.version);
    expect((await agent.get('/api/v1/flags/recovery').expect(200)).body.items).toEqual([]);
  });

  test('restore rejects stale versions and a reused flag key without overwriting data', async () => {
    let flag = await create(); flag = await edit(flag, { name: 'Newer' });
    await restore(flag.id, 'v1', 1).expect(409);
    flag = await edit(flag, { archived: true });
    await agent.delete(`/api/v1/flags/${flag.id}`).set('X-CSRF-Token', csrf).expect(204);
    const replacement = await create();
    await restore(flag.id, 'v1', null).expect(409);
    expect((await agent.get(`/api/v1/flags/${replacement.id}`).expect(200)).body.name).toBe('Original flag');
  });

  test('foreign team history and recovery are hidden; stolen version id cannot be restored', async () => {
    const flag = await create();
    auth.findById.mockResolvedValue({ ...user, teamId: randomUUID() });
    await agent.get(`/api/v1/flags/${flag.id}/history`).expect(404);
    expect((await agent.get('/api/v1/flags/recovery').expect(200)).body.items).toEqual([]);
    await restore(flag.id, 'v1', null).expect(404);
  });

  test('Developer can read own history but not restore or list deleted recovery', async () => {
    const flag = await create();
    auth.findById.mockResolvedValue({ ...user, role: 'developer' });
    await agent.get(`/api/v1/flags/${flag.id}/history`).expect(200);
    const denied = await restore(flag.id, 'v1', flag.version).expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    await agent.get('/api/v1/flags/recovery').expect(403);
  });

  test('auth, CSRF and strict restore input are enforced', async () => {
    const flag = await create();
    await request(app).get(`/api/v1/flags/${flag.id}/history`).expect(401);
    await agent.post(`/api/v1/flags/${flag.id}/restore`).send({ versionId: 'v1', version: 1 }).expect(403);
    await restore(flag.id, '', 1).expect(400);
    await agent.post(`/api/v1/flags/${flag.id}/restore`).set('X-CSRF-Token', csrf).send({ versionId: 'v1', version: 1, teamId: randomUUID() }).expect(400);
    await agent.get(`/api/v1/flags/${flag.id}/history?unexpected=true`).expect(400);
  });

  test('AWS write failure does not reverse the committed flag; audit failure does roll it back', async () => {
    snapshots.save.mockRejectedValueOnce(new Error('AWS unavailable'));
    const flag = await create();
    expect((await agent.get(`/api/v1/flags/${flag.id}`).expect(200)).body.id).toBe(flag.id);
    snapshots.save.mockClear();
    jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await agent.post('/api/v1/flags').set('X-CSRF-Token', csrf).send({ key: 'rollback-test', name: 'Rollback' }).expect(500);
    expect(snapshots.save).not.toHaveBeenCalled();
    expect((await client.query("SELECT id FROM flags WHERE team_id = $1 AND key = 'rollback-test'", [user.teamId])).rows).toEqual([]);
  });

  test('a restore audit failure rolls back settings and emits no new snapshot', async () => {
    let flag = await create(); flag = await edit(flag, { name: 'Keep this' }); snapshots.save.mockClear();
    jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    await restore(flag.id, 'v1', flag.version).expect(500);
    expect((await agent.get(`/api/v1/flags/${flag.id}`).expect(200)).body.name).toBe('Keep this');
    expect(snapshots.save).not.toHaveBeenCalled();
  });

  test('AWS-disabled deployment keeps ordinary flags working and explains disabled history', async () => {
    delete process.env.SNAPSHOT_BUCKET; delete process.env.SNAPSHOT_KMS_KEY;
    const flag = await create();
    expect((await agent.get(`/api/v1/flags/${flag.id}/history`).expect(200)).body.enabled).toBe(false);
    expect((await agent.get('/api/v1/flags/recovery').expect(200)).body.enabled).toBe(false);
    await restore(flag.id, 'v1', flag.version).expect(503);
    expect(snapshots.save).not.toHaveBeenCalled();
  });
});
