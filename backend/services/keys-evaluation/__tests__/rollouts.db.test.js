// Integration test against a real database: runs only when DATABASE_URL is set (CI sets it to a
// throwaway Postgres and connects as ffm_app, so the grants are tested too).
// Every test runs inside a transaction that is rolled back, so nothing is left behind.
const { Client } = require('pg');
const rollouts = require('../rollouts');

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('rollouts.createDefaults against Postgres', () => {
  let client;
  let flagId;

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
  });
  afterAll(() => client.end());

  // Like S1's create-flag service: insert the flag, then createDefaults in the same transaction.
  beforeEach(async () => {
    await client.query('BEGIN');
    const { rows: [team] } = await client.query(
      'INSERT INTO teams (name) VALUES ($1) RETURNING id', [`it-rollouts-${Date.now()}-${Math.random()}`],
    );
    ({ rows: [{ id: flagId }] } = await client.query(
      "INSERT INTO flags (team_id, key, name) VALUES ($1, 'it-new-checkout', 'New checkout') RETURNING id", [team.id],
    ));
  });
  afterEach(() => client.query('ROLLBACK'));

  test('a new flag gets three environments, off, and three rollouts at 0%, version 1', async () => {
    const result = await rollouts.createDefaults(client, flagId);
    expect(result).toEqual({
      dev: { percentage: 0, version: 1 },
      staging: { percentage: 0, version: 1 },
      prod: { percentage: 0, version: 1 },
    });

    const { rows: envs } = await client.query(
      'SELECT env, enabled FROM flag_environments WHERE flag_id = $1 ORDER BY env', [flagId],
    );
    expect(envs).toEqual([
      { env: 'dev', enabled: false },
      { env: 'prod', enabled: false },
      { env: 'staging', enabled: false },
    ]);
  });

  test('calling it again does not reset a rollout that was already changed', async () => {
    await rollouts.createDefaults(client, flagId);
    await client.query(
      "UPDATE rollouts SET percentage = 25, version = version + 1 WHERE flag_id = $1 AND env = 'staging'", [flagId],
    );

    const again = await rollouts.createDefaults(client, flagId);
    expect(again.staging).toEqual({ percentage: 25, version: 2 });
    const { rows: [{ count }] } = await client.query('SELECT count(*)::int FROM rollouts WHERE flag_id = $1', [flagId]);
    expect(count).toBe(3);
  });

  test('it keeps an environment row S1 already inserted (for example enabled in dev)', async () => {
    await client.query("INSERT INTO flag_environments (flag_id, env, enabled) VALUES ($1, 'dev', true)", [flagId]);
    await rollouts.createDefaults(client, flagId);
    const { rows: [dev] } = await client.query(
      "SELECT enabled FROM flag_environments WHERE flag_id = $1 AND env = 'dev'", [flagId],
    );
    expect(dev.enabled).toBe(true);
  });

  test('an unknown flag id fails, so the whole create-flag transaction rolls back', async () => {
    await client.query('SAVEPOINT unknown_flag');
    await expect(rollouts.createDefaults(client, '00000000-0000-4000-8000-000000000000'))
      .rejects.toThrow(/foreign key/);
    await client.query('ROLLBACK TO SAVEPOINT unknown_flag');
  });

  test('the PUT /rollouts version check now sees a stale version as 0 rows, not a missing row', async () => {
    await rollouts.createDefaults(client, flagId);
    const ok = await client.query(
      "UPDATE rollouts SET percentage = 25, version = version + 1 WHERE flag_id = $1 AND env = 'staging' AND version = 1",
      [flagId],
    );
    expect(ok.rowCount).toBe(1);
    const stale = await client.query(
      "UPDATE rollouts SET percentage = 50, version = version + 1 WHERE flag_id = $1 AND env = 'staging' AND version = 1",
      [flagId],
    );
    expect(stale.rowCount).toBe(0);
  });
});
