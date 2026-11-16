const rollouts = require('../rollouts');

const FLAG_ID = '3d6e0000-0000-4000-8000-000000000001';

// A stand-in for the pg transaction client: remembers every query and answers the final SELECT.
function fakeTx(selectRows) {
  return {
    query: jest.fn(async (sql) => (sql.trim().startsWith('SELECT') ? { rows: selectRows } : { rows: [] })),
  };
}

describe('createDefaults', () => {
  test('needs a transaction client', async () => {
    await expect(rollouts.createDefaults(undefined, FLAG_ID)).rejects.toThrow(TypeError);
    await expect(rollouts.createDefaults({}, FLAG_ID)).rejects.toThrow(TypeError);
  });

  test('needs a uuid flag id', async () => {
    const tx = fakeTx([]);
    for (const bad of [undefined, '', 'not-a-uuid', 42, `${FLAG_ID}' OR 1=1 --`]) {
      await expect(rollouts.createDefaults(tx, bad)).rejects.toThrow(TypeError);
    }
    expect(tx.query).not.toHaveBeenCalled();
  });

  test('creates flag_environments before rollouts, for dev, staging and prod', async () => {
    const tx = fakeTx([]);
    await rollouts.createDefaults(tx, FLAG_ID);

    const [envSql, envParams] = tx.query.mock.calls[0];
    const [rolloutSql, rolloutParams] = tx.query.mock.calls[1];
    expect(envSql).toMatch(/INSERT INTO flag_environments/);
    expect(rolloutSql).toMatch(/INSERT INTO rollouts/);
    expect(envParams).toEqual([FLAG_ID, ['dev', 'staging', 'prod']]);
    expect(rolloutParams).toEqual([FLAG_ID, ['dev', 'staging', 'prod']]);
  });

  test('never overwrites existing rows', async () => {
    const tx = fakeTx([]);
    await rollouts.createDefaults(tx, FLAG_ID);
    expect(tx.query.mock.calls[0][0]).toMatch(/ON CONFLICT \(flag_id, env\) DO NOTHING/);
    expect(tx.query.mock.calls[1][0]).toMatch(/ON CONFLICT \(flag_id, env\) DO NOTHING/);
  });

  test('returns every environment as numbers, in the GET /rollouts shape', async () => {
    const tx = fakeTx([
      { env: 'prod', percentage: '0.00', version: 1 },
      { env: 'dev', percentage: '0.00', version: 1 },
      { env: 'staging', percentage: '25.50', version: 3 },
    ]);
    await expect(rollouts.createDefaults(tx, FLAG_ID)).resolves.toEqual({
      dev: { percentage: 0, version: 1 },
      staging: { percentage: 25.5, version: 3 },
      prod: { percentage: 0, version: 1 },
    });
  });

  test('ENVS cannot be changed by a caller', () => {
    expect(Object.isFrozen(rollouts.ENVS)).toBe(true);
  });
});
