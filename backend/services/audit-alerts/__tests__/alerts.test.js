const alerts = require('../alerts');

const base = { team_id: 't1', actor_label: 'admin@acme.test', target_type: 'flag', target_id: 'f1' };
const row = (extra) => ({ ...base, category: 'change', details: {}, ...extra });

// Fake client: answers each query in turn from `answers` and remembers the SQL.
function fakeDb(...answers) {
  const db = { calls: [] };
  db.query = jest.fn(async (sql, params) => {
    db.calls.push({ sql, params });
    return { rows: answers.shift() ?? [] };
  });
  return db;
}

describe('candidateRule', () => {
  test.each([
    [row({ action: 'flag.toggled', details: { env: 'prod' } }), 'prod_change'],
    [row({ action: 'rollout.updated', details: { env: 'prod' } }), 'prod_change'],
    [row({ action: 'flag.toggled', details: { env: 'staging' } }), null],
    [row({ action: 'key.created', details: { env: 'staging' } }), 'key_change'],
    [row({ action: 'key.revoked' }), 'key_change'],
    [row({ action: 'login.failed', category: 'security' }), 'login_failures'],
    [row({ action: 'access.denied', category: 'security', details: { env: 'prod' } }), null],
    [row({ action: 'flag.toggled', details: { env: 'prod' }, team_id: null }), null],
  ])('%j -> %s', (r, expected) => {
    expect(alerts.candidateRule(r)).toBe(expected);
  });

  test('a key change in prod counts as a prod change', () => {
    expect(alerts.candidateRule(row({ action: 'key.created', details: { env: 'prod' } }))).toBe('prod_change');
  });
});

describe('raiseFor', () => {
  test('no matching rule means no query at all', async () => {
    const db = fakeDb();
    await expect(alerts.raiseFor(db, row({ action: 'flag.created' }), 1)).resolves.toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('an enabled rule inserts an open alert for that audit event', async () => {
    const created = { id: 'a1', rule: 'prod_change', title: 'x', status: 'open' };
    const db = fakeDb([{ enabled: true }], [created]);
    const r = row({ action: 'flag.toggled', details: { env: 'prod' } });
    await expect(alerts.raiseFor(db, r, 1042)).resolves.toEqual(created);
    expect(db.calls[1].sql).toMatch(/INSERT INTO alerts/);
    expect(db.calls[1].params).toEqual(['t1', 1042, 'prod_change', 'Prod change: flag.toggled on flag f1 by admin@acme.test']);
  });

  test('a disabled rule raises nothing (AUD-18)', async () => {
    const db = fakeDb([{ enabled: false }]);
    await expect(alerts.raiseFor(db, row({ action: 'key.revoked' }), 1)).resolves.toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('a team with no alert_rules row is treated as enabled', async () => {
    const db = fakeDb([], [{ id: 'a2' }]);
    await expect(alerts.raiseFor(db, row({ action: 'key.created' }), 7)).resolves.toEqual({ id: 'a2' });
  });

  test('login failures below the threshold raise nothing', async () => {
    const db = fakeDb([{ enabled: true }], [{ failures: alerts.LOGIN_FAILURE_THRESHOLD - 1, already_raised: false }]);
    await expect(alerts.raiseFor(db, row({ action: 'login.failed', category: 'security' }), 1)).resolves.toBeNull();
  });

  test('login failures at the threshold raise one alert', async () => {
    const db = fakeDb([{ enabled: true }], [{ failures: alerts.LOGIN_FAILURE_THRESHOLD, already_raised: false }], [{ id: 'a3' }]);
    await expect(alerts.raiseFor(db, row({ action: 'login.failed', category: 'security' }), 1)).resolves.toEqual({ id: 'a3' });
  });

  test('login failures already alerted in this window raise nothing more', async () => {
    const db = fakeDb([{ enabled: true }], [{ failures: 50, already_raised: true }]);
    await expect(alerts.raiseFor(db, row({ action: 'login.failed', category: 'security' }), 1)).resolves.toBeNull();
  });
});
