// ST-10 / AUD-14: the audit log is append-only for the application's database role.
// Runs only when DATABASE_URL logs in as ffm_app (always true in CI, see .github/workflows/ci.yml).
// As the owner role these statements would succeed, so the test is skipped there.
// Each statement runs inside a transaction that is rolled back, so nothing is ever changed.
const { Client } = require('pg');

const url = process.env.DATABASE_URL;
const runsAsApp = url ? new URL(url).username === 'ffm_app' : false;
const describeApp = runsAsApp ? describe : describe.skip;

describeApp('ST-10 audit tampering, as ffm_app', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
  });
  afterAll(() => client.end());

  // Runs one statement and returns the Postgres error, or null if it was allowed.
  async function attempt(sql) {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      return null;
    } catch (err) {
      return err;
    } finally {
      await client.query('ROLLBACK');
    }
  }

  test('the app really is connected as ffm_app', async () => {
    const { rows } = await client.query('SELECT current_user');
    expect(rows[0].current_user).toBe('ffm_app');
  });

  test.each([
    "UPDATE audit_events SET action = 'x'",
    'DELETE FROM audit_events',
    'TRUNCATE audit_events',
    'UPDATE login_attempts SET success = true',
    'DELETE FROM login_attempts',
    'SELECT * FROM schema_migrations',
  ])('%s is refused with "permission denied"', async (sql) => {
    const err = await attempt(sql);
    expect(err).not.toBeNull();
    expect(err.code).toBe('42501'); // insufficient_privilege
    expect(err.message).toMatch(/permission denied/);
  });

  test('adding to the audit log and reading it are still allowed', async () => {
    const err = await attempt(
      `INSERT INTO audit_events (actor_label, category, action) VALUES ('st-10', 'security', 'test.insert');
       SELECT count(*) FROM audit_events`,
    );
    expect(err).toBeNull();
  });
});
