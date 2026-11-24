// Integration test for PUT /rollouts (setPercentage) and POST /evaluations (the SQL in
// evaluations.js) against a real database. Runs only when DATABASE_URL is set (CI connects as
// ffm_app, so the grants are tested too). Every test is rolled back, so nothing is left behind.
const { Client } = require('pg');
const rollouts = require('../rollouts');
const evaluations = require('../evaluations');
const { evaluate } = require('../evaluate');
const { newKey } = require('../../../shared/api-keys');

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('rollouts and evaluations against Postgres', () => {
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
    const name = `it-eval-${Date.now()}-${Math.random()}`;
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

  describe('setPercentage', () => {
    test('works on a flag with no rollout rows yet (like the seed data), and writes rollout.updated', async () => {
      const result = await rollouts.setPercentage(client, req, { teamId, flagId, env: 'staging', percentage: 25, version: 1 });
      expect(result).toMatchObject({ flagId, env: 'staging', percentage: 25, version: 2 });

      const { rows: [audit] } = await client.query(
        "SELECT action, target_id, details, actor_label FROM audit_events WHERE team_id = $1 AND action = 'rollout.updated'", [teamId],
      );
      expect(audit).toMatchObject({
        target_id: `${flagId}/staging`,
        actor_label: req.user.email,
        details: { key: 'it-checkout', env: 'staging', before: { percentage: 0 }, after: { percentage: 25 } },
      });
    });

    test('stores 2 decimals', async () => {
      const result = await rollouts.setPercentage(client, req, { teamId, flagId, env: 'dev', percentage: 12.5, version: 1 });
      expect(result.percentage).toBe(12.5);
    });

    test('409 STALE_VERSION when the version is old', async () => {
      await rollouts.setPercentage(client, req, { teamId, flagId, env: 'staging', percentage: 25, version: 1 });
      await expect(rollouts.setPercentage(client, req, { teamId, flagId, env: 'staging', percentage: 50, version: 1 }))
        .rejects.toMatchObject({ status: 409, code: 'STALE_VERSION' });
    });

    test('404 for another team', async () => {
      await expect(rollouts.setPercentage(client, req, { teamId: otherTeamId, flagId, env: 'staging', percentage: 25, version: 1 }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });

  describe('evaluations', () => {
    let key;
    beforeEach(async () => {
      key = newKey('staging');
      await client.query(
        "INSERT INTO api_keys (team_id, env, name, prefix, key_hash) VALUES ($1, 'staging', 'it key', $2, $3)",
        [teamId, key.prefix, key.keyHash],
      );
      await rollouts.createDefaults(client, flagId);
    });

    test('findKey finds the key by its hash only', async () => {
      expect(await evaluations.findKey(client, key.keyHash)).toMatchObject({ teamId, env: 'staging', prefix: key.prefix, revoked: false });
      expect(await evaluations.findKey(client, newKey('staging').keyHash)).toBeNull();
      await client.query('UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1', [key.keyHash]);
      expect((await evaluations.findKey(client, key.keyHash)).revoked).toBe(true);
    });

    test('loadSetting: off and 0% by default, then on at 100% for everyone', async () => {
      let setting = await evaluations.loadSetting(client, teamId, 'staging', 'it-checkout');
      expect(setting).toEqual({ archived: false, enabled: false, percentage: '0.00', allow: [], block: [] });
      expect(evaluate(setting, 'it-checkout', 'u-1').enabled).toBe(false);

      await client.query("UPDATE flag_environments SET enabled = true WHERE flag_id = $1 AND env = 'staging'", [flagId]);
      await rollouts.setPercentage(client, req, { teamId, flagId, env: 'staging', percentage: 100, version: 1 });
      setting = await evaluations.loadSetting(client, teamId, 'staging', 'it-checkout');
      expect(evaluate(setting, 'it-checkout', 'u-1').enabled).toBe(true);
    });

    test('loadSetting reads only the requested env (a staging key never sees prod)', async () => {
      await client.query("UPDATE flag_environments SET enabled = true WHERE flag_id = $1 AND env = 'prod'", [flagId]);
      await client.query("UPDATE rollouts SET percentage = 100 WHERE flag_id = $1 AND env = 'prod'", [flagId]);
      const setting = await evaluations.loadSetting(client, teamId, 'staging', 'it-checkout');
      expect(evaluate(setting, 'it-checkout', 'u-1').enabled).toBe(false);
    });

    test('loadSetting returns the allow and block lists for that env', async () => {
      await client.query(
        `INSERT INTO user_rules (flag_id, env, user_id, kind) VALUES
         ($1, 'staging', 'u-allow', 'allow'), ($1, 'staging', 'u-block', 'block'), ($1, 'prod', 'u-prod', 'allow')`,
        [flagId],
      );
      const setting = await evaluations.loadSetting(client, teamId, 'staging', 'it-checkout');
      expect(setting.allow).toEqual(['u-allow']);
      expect(setting.block).toEqual(['u-block']);
    });

    test('loadSetting returns null for a flag of another team', async () => {
      expect(await evaluations.loadSetting(client, otherTeamId, 'staging', 'it-checkout')).toBeNull();
    });

    test('loadSettings reads many flags of the team in one query, only for that env', async () => {
      await client.query(
        "INSERT INTO flags (team_id, key, name) VALUES ($1, 'it-gift-wrap', 'Gift wrap'), ($2, 'it-other-team', 'Other')",
        [teamId, otherTeamId],
      );
      await client.query("UPDATE flag_environments SET enabled = true WHERE flag_id = $1 AND env = 'prod'", [flagId]);
      await client.query("INSERT INTO user_rules (flag_id, env, user_id, kind) VALUES ($1, 'staging', 'u-allow', 'allow')", [flagId]);
      const settings = await evaluations.loadSettings(client, teamId, 'staging', ['it-checkout', 'it-gift-wrap', 'it-other-team', 'nope']);
      expect([...settings.keys()].sort()).toEqual(['it-checkout', 'it-gift-wrap']);
      expect(settings.get('it-checkout')).toEqual({ archived: false, enabled: false, percentage: '0.00', allow: ['u-allow'], block: [] });
      // it-gift-wrap has no environment or rollout rows: off and 0%
      expect(settings.get('it-gift-wrap')).toMatchObject({ enabled: false, allow: [], block: [] });
      expect(Number(settings.get('it-gift-wrap').percentage)).toBe(0);
    });

    test('countRequest: 120 allowed, the 121st is the first refusal, then refused without writing', async () => {
      const { id } = await evaluations.findKey(client, key.keyHash);
      for (let i = 0; i < evaluations.RATE_LIMIT; i += 1) {
        expect(await evaluations.countRequest(client, id)).toEqual({ allowed: true, firstRefusal: false });
      }
      expect(await evaluations.countRequest(client, id)).toEqual({ allowed: false, firstRefusal: true });
      expect(await evaluations.countRequest(client, id)).toEqual({ allowed: false, firstRefusal: false });
      const { rows: [row] } = await client.query('SELECT count FROM api_key_usage WHERE key_id = $1', [id]);
      expect(row.count).toBe(evaluations.RATE_LIMIT + 1); // stopped growing
    });

    test('countRequest: an old minute is tidied up when a new minute starts', async () => {
      const { id } = await evaluations.findKey(client, key.keyHash);
      await client.query(
        "INSERT INTO api_key_usage (key_id, window_start, count) VALUES ($1, date_trunc('minute', now()) - interval '5 minutes', 120)", [id],
      );
      expect(await evaluations.countRequest(client, id)).toEqual({ allowed: true, firstRefusal: false });
      const { rows } = await client.query('SELECT count FROM api_key_usage WHERE key_id = $1', [id]);
      expect(rows).toEqual([{ count: 1 }]);
    });

    test('secondsToNextWindow is 1 to 60', () => {
      expect(evaluations.secondsToNextWindow(0)).toBe(60);
      expect(evaluations.secondsToNextWindow(59500)).toBe(1);
      expect(evaluations.secondsToNextWindow(30000)).toBe(30);
    });

    test('touchKey sets lastUsedAt, then not again within a minute', async () => {
      const { id } = await evaluations.findKey(client, key.keyHash);
      await evaluations.touchKey(client, id);
      const { rows: [first] } = await client.query('SELECT last_used_at FROM api_keys WHERE id = $1', [id]);
      expect(first.last_used_at).not.toBeNull();
      const second = await client.query(
        "UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [id],
      );
      expect(second.rowCount).toBe(0);
    });
  });
});
