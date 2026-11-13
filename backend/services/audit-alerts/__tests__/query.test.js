const query = require('../query');
const { encodeCursor } = require('../schema');

function fakeDb(rows = []) {
  return { query: jest.fn(async () => ({ rows })) };
}

const dbRow = (id) => ({
  id: String(id), at: new Date('2026-11-13T14:05:00Z'), actor_label: 'dev@acme.test', actor_id: 'u1',
  category: 'change', action: 'flag.toggled', target_type: 'flag', target_id: 'f1',
  details: { before: { enabled: false } }, request_id: 'r1',
});

describe('listEvents', () => {
  test('always scoped to the team, filters are parameters, never SQL text', async () => {
    const db = fakeDb();
    await query.listEvents('team-1', {
      actor: "dev@acme.test' OR '1'='1", action: 'flag.toggled', category: 'change',
      from: new Date('2026-11-01'), to: new Date('2026-11-03'), cursor: '50', limit: 25,
    }, db);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE team_id = \$1 AND/);
    expect(sql).not.toContain("OR '1'='1");
    expect(params).toEqual(['team-1', "dev@acme.test' OR '1'='1", 'flag.toggled', 'change',
      new Date('2026-11-01'), new Date('2026-11-03'), '50', 26]);
  });

  test('maps rows to the API shape', async () => {
    const { items } = await query.listEvents('t', { limit: 25 }, fakeDb([dbRow(3)]));
    expect(items[0]).toEqual({
      id: 3, at: new Date('2026-11-13T14:05:00Z'), actorLabel: 'dev@acme.test', actorId: 'u1',
      category: 'change', action: 'flag.toggled', targetType: 'flag', targetId: 'f1',
      details: { before: { enabled: false } }, requestId: 'r1',
    });
  });

  test('nextCursor points at the last item when there is another page', async () => {
    const page = await query.listEvents('t', { limit: 2 }, fakeDb([dbRow(9), dbRow(8), dbRow(7)]));
    expect(page.items.map((e) => e.id)).toEqual([9, 8]);
    expect(page.nextCursor).toBe(encodeCursor('8'));
  });

  test('nextCursor is null on the last page', async () => {
    const page = await query.listEvents('t', { limit: 2 }, fakeDb([dbRow(9)]));
    expect(page.nextCursor).toBeNull();
  });
});

describe('exportEvents', () => {
  test('ignores any cursor and caps the row count', async () => {
    const db = fakeDb();
    await query.exportEvents('t', { cursor: '5' }, db);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/id </);
    expect(params).toEqual(['t', query.EXPORT_LIMIT]);
  });
});
