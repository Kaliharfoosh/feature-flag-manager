// Integration test for getRollouts and the allow/block rules against a real database.
// Runs only when DATABASE_URL is set (CI connects as ffm_app, so the grants are tested too).
// Every test is rolled back, so nothing is left behind.
const { Client } = require('pg');
const rollouts = require('../rollouts');
const rules = require('../rules');
const evaluations = require('../evaluations');
const { evaluate } = require('../evaluate');

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('rollouts and rules against Postgres', () => {
  let client;
  let teamId;
  let otherTeamId;
  let flagId;
  let req;

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
  });
  afterAll(() => client.end());

  beforeEach(async () => {
    await client.query('BEGIN');
    const name = `it-rules-${Date.now()}-${Math.random()}`;
    ({ rows: [{ id: teamId }] } = await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name]));
    ({ rows: [{ id: otherTeamId }] } = await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [`${name}-other`]));
    ({ rows: [{ id: flagId }] } = await client.query(
      "INSERT INTO flags (team_id, key, name) VALUES ($1, 'it-checkout', 'Checkout') RETURNING id", [teamId],
    ));
    const { rows: [user] } = await client.query(
      "INSERT INTO users (team_id, email, name, password_hash, role) VALUES ($1, $2, 'Dev', 'x', 'developer') RETURNING id",
      [teamId, `${name}@acme.test`],
    );
    req = { id: 'req-1', ip: '127.0.0.1', user: { id: user.id, email: `${name}@acme.test`, role: 'developer', teamId } };
  });
  afterEach(() => client.query('ROLLBACK'));

  const auditFor = async (action) => (await client.query(
    'SELECT target_id, details FROM audit_events WHERE team_id = $1 AND action = $2', [teamId, action],
  )).rows;

  describe('getRollouts', () => {
    test('a flag with no rollout rows reads as 0%, version 1 everywhere', async () => {
      expect(await rollouts.getRollouts(client, teamId, flagId)).toEqual({
        flagId,
        environments: { dev: { percentage: 0, version: 1 }, staging: { percentage: 0, version: 1 }, prod: { percentage: 0, version: 1 } },
      });
    });

    test('shows a change made with setPercentage, and its version works for the next PUT', async () => {
      await rollouts.setPercentage(client, req, { teamId, flagId, env: 'staging', percentage: 25, version: 1 });
      const { environments } = await rollouts.getRollouts(client, teamId, flagId);
      expect(environments.staging).toEqual({ percentage: 25, version: 2 });
      await rollouts.setPercentage(client, req, { teamId, flagId, env: 'staging', percentage: 50, version: environments.staging.version });
    });

    test('null for another team', async () => {
      expect(await rollouts.getRollouts(client, otherTeamId, flagId)).toBeNull();
    });
  });

  describe('rules', () => {
    test('add, list and remove, each audited with the flag key, env, user and kind', async () => {
      const rule = await rules.addRule(client, req, { teamId, flagId, env: 'staging', userId: 'u-981', kind: 'allow' });
      expect(rule).toMatchObject({ userId: 'u-981', kind: 'allow' });
      expect(await rules.listRules(client, teamId, flagId, 'staging')).toEqual([rule]);
      expect(await rules.listRules(client, teamId, flagId, 'prod')).toEqual([]);

      const found = await rules.findRule(client, teamId, rule.id);
      expect(found).toMatchObject({ id: rule.id, env: 'staging', userId: 'u-981', kind: 'allow', flagKey: 'it-checkout' });
      expect(await rules.removeRule(client, req, found)).toBe(true);
      expect(await rules.removeRule(client, req, found)).toBe(false); // already gone
      expect(await rules.listRules(client, teamId, flagId, 'staging')).toEqual([]);

      const details = { key: 'it-checkout', env: 'staging', userId: 'u-981', kind: 'allow' };
      expect(await auditFor('rule.added')).toEqual([{ target_id: rule.id, details }]);
      expect(await auditFor('rule.removed')).toEqual([{ target_id: rule.id, details }]);
    });

    test('409 for a second rule for the same user, flag and env; fine in another env', async () => {
      await rules.addRule(client, req, { teamId, flagId, env: 'staging', userId: 'u-1', kind: 'allow' });
      await expect(rules.addRule(client, req, { teamId, flagId, env: 'staging', userId: 'u-1', kind: 'block' }))
        .rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
      await rules.addRule(client, req, { teamId, flagId, env: 'dev', userId: 'u-1', kind: 'block' });
    });

    test('another team cannot list, add or find the rules', async () => {
      const rule = await rules.addRule(client, req, { teamId, flagId, env: 'staging', userId: 'u-1', kind: 'allow' });
      await expect(rules.listRules(client, otherTeamId, flagId, 'staging')).rejects.toMatchObject({ status: 404 });
      await expect(rules.addRule(client, req, { teamId: otherTeamId, flagId, env: 'staging', userId: 'u-2', kind: 'allow' }))
        .rejects.toMatchObject({ status: 404 });
      expect(await rules.findRule(client, otherTeamId, rule.id)).toBeNull();
    });

    test('rules change what evaluations answer (same SQL as /evaluations and /preview)', async () => {
      await rules.addRule(client, req, { teamId, flagId, env: 'staging', userId: 'u-vip', kind: 'allow' });
      await rules.addRule(client, req, { teamId, flagId, env: 'staging', userId: 'u-bad', kind: 'block' });
      await client.query("UPDATE flag_environments SET enabled = true WHERE flag_id = $1 AND env = 'staging'", [flagId]);
      await rollouts.setPercentage(client, req, { teamId, flagId, env: 'staging', percentage: 100, version: 1 });

      const setting = await evaluations.loadSetting(client, teamId, 'staging', 'it-checkout');
      expect(evaluate(setting, 'it-checkout', 'u-vip')).toMatchObject({ enabled: true, reason: 'allowlisted' });
      expect(evaluate(setting, 'it-checkout', 'u-bad')).toMatchObject({ enabled: false, reason: 'blocklisted' });
      expect(evaluate(setting, 'it-checkout', 'anyone')).toMatchObject({ enabled: true, reason: 'in-percentage' });
    });
  });
});
