const schema = require('../schema');

const expect400 = (fn, message) => {
  try {
    fn();
  } catch (err) {
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    if (message) expect(err.message).toMatch(message);
    return;
  }
  throw new Error('expected a 400');
};

describe('parseAuditList', () => {
  test('defaults: limit 25, no filters', () => {
    expect(schema.parseAuditList({})).toEqual({ limit: 25 });
  });

  test('accepts every filter', () => {
    const out = schema.parseAuditList({
      actor: 'dev@acme.test', action: 'rollout.updated', category: 'change',
      from: '2026-11-01', to: '2026-11-02', limit: '2', cursor: schema.encodeCursor(1042),
    });
    expect(out).toEqual({
      actor: 'dev@acme.test', action: 'rollout.updated', category: 'change',
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-03T00:00:00.000Z'), // a date-only "to" includes that whole day
      limit: 2, cursor: '1042',
    });
  });

  test('a full ISO time is used as given', () => {
    expect(schema.parseAuditList({ to: '2026-11-02T10:30:00Z' }).to).toEqual(new Date('2026-11-02T10:30:00Z'));
  });

  test.each([
    [{ from: 'yesterday' }, /from/],               // AUD-05
    [{ from: '2026-13-45' }, /from/],
    [{ to: '2026-11-02T25:00:00Z' }, /to/],
    [{ from: '2026-11-05', to: '2026-11-01' }, /before/],
    [{ limit: '0' }, /limit/],
    [{ limit: '101' }, /limit/],
    [{ limit: 'ten' }, /limit/],
    [{ category: 'other' }, /category/],
    [{ action: "x'; DROP TABLE audit_events;--" }, /action/],
    [{ cursor: 'not-a-cursor' }, /cursor/],
    [{ cursor: schema.encodeCursor('1 OR 1=1') }, /cursor/],
    [{ actor: 'a'.repeat(300) }, /actor/],
    [{ team_id: 'someone-elses-team' }, /Unknown query parameter: team_id/], // no mass assignment
  ])('rejects %j', (query, message) => {
    expect400(() => schema.parseAuditList(query), message);
  });
});

describe('parseAuditExport', () => {
  test('has no paging parameters', () => {
    expect400(() => schema.parseAuditExport({ limit: '10' }), /Unknown query parameter/);
    expect(schema.parseAuditExport({ category: 'security' })).toEqual({ category: 'security' });
  });
});

describe('parseSummary and parseMonitoring', () => {
  test('defaults', () => {
    expect(schema.parseSummary({})).toEqual({ days: 7 });
    expect(schema.parseMonitoring({})).toEqual({ hours: 24 });
  });

  test('ranges (AUD-10, AUD-17)', () => {
    expect400(() => schema.parseSummary({ days: '0' }), /days/);
    expect400(() => schema.parseSummary({ days: '91' }), /days/);
    expect400(() => schema.parseMonitoring({ hours: '1000' }), /hours/);
    expect(schema.parseMonitoring({ hours: '168' })).toEqual({ hours: 168 });
  });
});
