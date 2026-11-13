const audit = require('../audit');

const user = { id: '7f2c0000-0000-4000-8000-000000000001', email: 'dev@acme.test', role: 'developer', teamId: 'a1b20000-0000-4000-8000-000000000001' };
const reqAs = (extra = {}) => ({ id: 'req-123', ip: '203.0.113.7', ...extra });

// A stand-in for the pg transaction client: remembers every query.
function fakeTx() {
  return { query: jest.fn(async () => ({ rows: [{ id: '42', at: new Date('2026-11-13T14:05:00Z') }] })) };
}

describe('redact', () => {
  test('keeps allowlisted fields and redacts everything else', () => {
    expect(audit.redact({ enabled: true, password: 'hunter2', password_hash: '$2a$12$x' }))
      .toEqual({ enabled: true, password: '[REDACTED]', password_hash: '[REDACTED]' });
  });

  test('redacts inside before/after and nested objects', () => {
    const out = audit.redact({
      before: { percentage: 0, key_hash: 'abc' },
      after: { percentage: 25, token: 't0k3n' },
    });
    expect(out).toEqual({
      before: { percentage: 0, key_hash: '[REDACTED]' },
      after: { percentage: 25, token: '[REDACTED]' },
    });
  });

  test('a raw API key is redacted even under an allowed name', () => {
    const out = audit.redact({ key: 'ffm_prd_Ab12Cd_9f8e7d6c5b4a', name: 'leaked ffm_stg_Xy34Zz_secret here' });
    expect(out.key).toBe('[REDACTED]');
    expect(out.name).toBe('leaked [REDACTED] here');
  });

  test('keeps the display prefix of a key, but not a full key stored as the prefix', () => {
    expect(audit.redact({ after: { prefix: 'ffm_stg_Ab12Cd', name: 'CI key' } }))
      .toEqual({ after: { prefix: 'ffm_stg_Ab12Cd', name: 'CI key' } });
    expect(audit.redact({ prefix: 'ffm_stg_Ab12Cd_9f8e7d6c5b4a3210' }).prefix).toBe('[REDACTED]');
  });

  test('limits long strings and deep nesting', () => {
    const out = audit.redact({ description: 'x'.repeat(2000), before: { after: { before: { after: { before: { enabled: true } } } } } });
    expect(out.description).toHaveLength(500);
    expect(out.before.after.before.after).toEqual({ before: '[REDACTED]' }); // 4 levels kept, the 5th cut
  });

  test('rejects details that are not an object', () => {
    expect(() => audit.redact('password=hunter2')).toThrow(TypeError);
    expect(() => audit.redact(['a'])).toThrow(TypeError);
  });
});

describe('buildRow', () => {
  test('a signed-in user is the actor and their team owns the event', () => {
    const row = audit.buildRow(reqAs({ user }), {
      action: 'flag.toggled', targetType: 'flag', targetId: 'f1',
      before: { enabled: false }, after: { enabled: true },
    });
    expect(row).toEqual({
      team_id: user.teamId, actor_id: user.id, actor_label: 'dev@acme.test',
      category: 'change', action: 'flag.toggled', target_type: 'flag', target_id: 'f1',
      details: { before: { enabled: false }, after: { enabled: true } },
      request_id: 'req-123', ip: '203.0.113.7',
    });
  });

  test('an API key is labelled by its prefix, never the key', () => {
    const row = audit.buildRow(reqAs({ apiKey: { id: 'k1', teamId: 't1', prefix: 'ffm_stg_Ab12Cd', env: 'staging' } }), { action: 'evaluation.denied', category: 'security' });
    expect(row.actor_label).toBe('api-key:ffm_stg_Ab12Cd');
    expect(row.actor_id).toBeNull();
    expect(row.team_id).toBe('t1');
  });

  test('no user and no key is anonymous, and teamId can be given explicitly', () => {
    const row = audit.buildRow(reqAs(), { action: 'login.failed', category: 'security', teamId: 't9' });
    expect(row.actor_label).toBe('anonymous');
    expect(row.team_id).toBe('t9');
  });

  test('targetId is stored as text', () => {
    expect(audit.buildRow(reqAs({ user }), { action: 'alert.raised', targetId: 1042 }).target_id).toBe('1042');
  });

  test.each([
    [{ action: 'Flag Toggled' }],
    [{ action: 'flag' }],
    [{}],
    [{ action: 'flag.toggled', category: 'other' }],
  ])('rejects a bad event %j', (event) => {
    expect(() => audit.buildRow(reqAs({ user }), event)).toThrow(TypeError);
  });
});

describe('record', () => {
  test('inserts one row on the given transaction client and returns its id', async () => {
    const tx = fakeTx();
    const result = await audit.record(tx, reqAs({ user }), {
      action: 'rollout.updated', targetType: 'rollout', targetId: 'f1/staging',
      before: { percentage: 0 }, after: { percentage: 25 },
    });
    expect(result).toEqual({ id: 42, at: new Date('2026-11-13T14:05:00Z'), alert: null }); // staging: no rule
    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO audit_events/);
    expect(params).toEqual([
      user.teamId, user.id, 'dev@acme.test', 'change', 'rollout.updated', 'rollout', 'f1/staging',
      JSON.stringify({ before: { percentage: 0 }, after: { percentage: 25 } }), 'req-123', '203.0.113.7',
    ]);
  });

  test('a failed insert throws, so the caller rolls the change back', async () => {
    const tx = { query: jest.fn(async () => { throw new Error('permission denied'); }) };
    await expect(audit.record(tx, reqAs({ user }), { action: 'flag.created' })).rejects.toThrow('permission denied');
  });

  test('needs a client', async () => {
    await expect(audit.record(null, reqAs({ user }), { action: 'flag.created' })).rejects.toThrow(TypeError);
  });
});

describe('recordSecurity', () => {
  test('writes a security event', async () => {
    const db = fakeTx();
    await audit.recordSecurity(reqAs(), 'access.denied', { method: 'PATCH', path: '/api/v1/flags/f1/environments/prod', requiredRole: 'admin' }, { db });
    const [, params] = db.query.mock.calls[0];
    expect(params[3]).toBe('security');
    expect(params[4]).toBe('access.denied');
  });

  test('a database failure is logged, not thrown', async () => {
    const db = { query: jest.fn(async () => { throw new Error('db down'); }) };
    const log = { error: jest.fn() };
    await expect(audit.recordSecurity(reqAs({ log }), 'login.failed', {}, { db })).resolves.toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  test('a bad action name still throws', async () => {
    await expect(audit.recordSecurity(reqAs(), 'oops', {}, { db: fakeTx() })).rejects.toThrow(TypeError);
  });
});
