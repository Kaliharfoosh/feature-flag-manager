// Uses savepoints inside a rolled-back fixture transaction so the same tests
// can run on a development database without leaving teams, flags or audit rows.
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { pool } = require('../../../db/pool');
const audit = require('../../../shared/audit');
const { createFlag, toggleEnvironment } = require('../service');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('flag creation and environment toggles against PostgreSQL', () => {
  let client;
  let connection;
  let req;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    connection = jest.spyOn(pool, 'connect').mockResolvedValue({
      query: (sql, params) => {
        const statements = {
          BEGIN: 'SAVEPOINT create_flag_test',
          COMMIT: 'RELEASE SAVEPOINT create_flag_test',
          ROLLBACK: 'ROLLBACK TO SAVEPOINT create_flag_test',
        };
        return client.query(statements[sql] ?? sql, params);
      },
      release: () => {},
    });
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    const { rows: [team] } = await client.query(
      'INSERT INTO teams (name) VALUES ($1) RETURNING id', ['flag-create-' + randomUUID()],
    );
    const { rows: [user] } = await client.query(
      `INSERT INTO users (team_id, email, name, password_hash, role)
       VALUES ($1, 'creator@it.test', 'Flag Creator', 'unused-test-hash', 'developer')
       RETURNING id, email, team_id AS "teamId", role`, [team.id],
    );
    req = { user, id: randomUUID(), ip: '192.0.2.10' };
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    connection?.mockRestore();
    await client?.end();
    await pool.end();
  });

  test('creates all three defaults and a team-scoped audit record', async () => {
    const flag = await createFlag(req, { key: 'beta-search', name: 'Beta search', description: '' });
    expect(flag.createdBy).toBe(req.user.id);
    expect(flag.environments).toEqual(Object.fromEntries(
      ['dev', 'staging', 'prod'].map(env => [env, { enabled: false, percentage: 0, version: 1 }]),
    ));
    const { rows } = await client.query(
      `SELECT fe.env, fe.enabled, r.percentage, r.version
       FROM flag_environments fe JOIN rollouts r USING (flag_id, env)
       WHERE flag_id = $1 ORDER BY env`, [flag.id],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every(row => !row.enabled && Number(row.percentage) === 0 && row.version === 1)).toBe(true);
    const { rows: [event] } = await client.query(
      "SELECT team_id, actor_id, details FROM audit_events WHERE action = 'flag.created' AND target_id = $1", [flag.id],
    );
    expect(event.team_id).toBe(req.user.teamId);
    expect(event.actor_id).toBe(req.user.id);
    expect(event.details.after).toMatchObject({ key: flag.key, name: flag.name });
  });

  test('rejects duplicate keys within a team and allows them in another team', async () => {
    const input = { key: 'beta-search', name: 'Beta search', description: '' };
    await createFlag(req, input);
    await expect(createFlag(req, input)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    const { rows: [other] } = await client.query(
      'INSERT INTO teams (name) VALUES ($1) RETURNING id', ['other-' + randomUUID()],
    );
    // A second authenticated actor belongs to the second team.
    const { rows: [otherUser] } = await client.query(
      `INSERT INTO users (team_id, email, name, password_hash, role)
       VALUES ($1, $2, 'Other Creator', 'unused-test-hash', 'admin')
       RETURNING id, email, team_id AS "teamId", role`, [other.id, randomUUID() + '@it.test'],
    );
    const created = await createFlag({ ...req, user: otherUser }, input);
    expect(created.key).toBe(input.key);
    const { rows } = await client.query('SELECT id FROM flags WHERE key = $1', [input.key]);
    expect(rows).toHaveLength(2);
  });

  test('leaves no flag or defaults when the audit write fails', async () => {
    const failure = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      await expect(createFlag(req, { key: 'audit-failure', name: 'Audit failure', description: '' })).rejects.toThrow('audit unavailable');
    } finally {
      failure.mockRestore();
    }
    const { rows } = await client.query('SELECT id FROM flags WHERE team_id = $1', [req.user.teamId]);
    expect(rows).toEqual([]);
  });

  test('an environment toggle increments only its own version and audits before/after', async () => {
    const flag = await createFlag(req, { key: 'toggle-test', name: 'Toggle test', description: '' });
    const changed = await toggleEnvironment(req, { flagId: flag.id, env: 'staging', enabled: true, version: 1 });
    expect(changed).toMatchObject({ flagId: flag.id, env: 'staging', enabled: true, version: 2 });
    const { rows } = await client.query(
      `SELECT fe.env, fe.enabled, fe.version, r.percentage, r.version AS rollout_version
       FROM flag_environments fe JOIN rollouts r USING (flag_id, env) WHERE flag_id = $1`, [flag.id],
    );
    expect(rows.find(row => row.env === 'staging')).toMatchObject({ enabled: true, version: 2, rollout_version: 1 });
    expect(rows.every(row => Number(row.percentage) === 0)).toBe(true);
    expect(rows.filter(row => row.env !== 'staging').every(row => row.version === 1 && !row.enabled)).toBe(true);
    const { rows: [stored] } = await client.query('SELECT version FROM flags WHERE id = $1', [flag.id]);
    expect(stored.version).toBe(2);
    const { rows: [event] } = await client.query("SELECT details FROM audit_events WHERE action = 'flag.toggled' AND target_id = $1", [flag.id]);
    expect(event.details).toMatchObject({ env: 'staging', before: { enabled: false }, after: { enabled: true } });
    await expect(toggleEnvironment(req, { flagId: flag.id, env: 'staging', enabled: false, version: 1 }))
      .rejects.toMatchObject({ status: 409, code: 'STALE_VERSION' });
    const { rows: [unchanged] } = await client.query("SELECT enabled, version FROM flag_environments WHERE flag_id = $1 AND env = 'staging'", [flag.id]);
    expect(unchanged).toEqual({ enabled: true, version: 2 });
  });

  test('an audit failure rolls back both the environment and flag versions', async () => {
    const flag = await createFlag(req, { key: 'toggle-rollback', name: 'Rollback', description: '' });
    const failure = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      await expect(toggleEnvironment(req, { flagId: flag.id, env: 'dev', enabled: true, version: 1 })).rejects.toThrow('audit unavailable');
    } finally { failure.mockRestore(); }
    const { rows: [stored] } = await client.query(
      "SELECT f.version, fe.version AS env_version, fe.enabled FROM flags f JOIN flag_environments fe ON fe.flag_id = f.id AND fe.env = 'dev' WHERE f.id = $1", [flag.id],
    );
    expect(stored).toEqual({ version: 1, env_version: 1, enabled: false });
  });

  test('an older flag with a missing environment can be toggled from its initial version', async () => {
    const flag = await createFlag(req, { key: 'legacy-flag', name: 'Legacy flag', description: '' });
    await client.query("DELETE FROM flag_environments WHERE flag_id = $1 AND env = 'dev'", [flag.id]);
    const changed = await toggleEnvironment(req, { flagId: flag.id, env: 'dev', enabled: true, version: 1 });
    expect(changed).toMatchObject({ enabled: true, version: 2 });
  });
});
