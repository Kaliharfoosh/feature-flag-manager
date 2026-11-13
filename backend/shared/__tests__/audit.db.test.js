// Integration test against a real database: runs only when DATABASE_URL is set, e.g.
//   node --env-file=.env node_modules/jest/bin/jest.js backend/shared
// Everything happens inside a transaction that is rolled back, so nothing is left behind.
const { Client } = require('pg');
const audit = require('../audit');

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('audit.record against Postgres', () => {
  let client;
  const req = { id: 'it-req-1', ip: '127.0.0.1' };

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
    await require('../../db/pool').pool.end();
  });

  test('the row is stored redacted, and a rollback removes it with the change', async () => {
    await client.query('BEGIN');
    let id;
    try {
      ({ id } = await audit.record(client, req, {
        action: 'flag.created', targetType: 'flag', targetId: 'it-flag',
        after: { key: 'it-flag', password: 'never-stored' },
      }));
      const { rows } = await client.query('SELECT actor_label, category, details, request_id FROM audit_events WHERE id = $1', [id]);
      expect(rows[0]).toEqual({
        actor_label: 'anonymous', category: 'change', request_id: 'it-req-1',
        details: { after: { key: 'it-flag', password: '[REDACTED]' } },
      });
    } finally {
      await client.query('ROLLBACK');
    }
    const { rowCount } = await client.query('SELECT 1 FROM audit_events WHERE id = $1', [id]);
    expect(rowCount).toBe(0);
  });
});
