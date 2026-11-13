const bcrypt = require('bcryptjs');
const { createHash } = require('node:crypto');
const { pool } = require('../../db/pool');
const audit = require('../../shared/audit');

const userFields = 'id, email, name, role, team_id AS "teamId"';
// Match the bcrypt cost used by the seed for unknown email addresses.
const dummyHash = '$2b$12$k6p2r9HGujZ3IIuNYFkim.hMAb6PpFfpes7tmai19kx.niIpbrjr6';

async function authenticate({ email, password, ip, requestId }) {
  const emailHash = createHash('sha256').update(email).digest('hex');
  const client = await pool.connect();
  const auditReq = { id: requestId, ip }; // who/where for audit.record(); no user yet

  let rollbackError;
  try {
    await client.query('BEGIN');
    // Serialize attempts sharing an email or IP across app instances. Separate
    // lock namespaces let every transaction acquire email first, then IP.
    await client.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', [emailHash]);
    if (ip) {
      await client.query('SELECT pg_advisory_xact_lock(2, hashtext($1))', [ip]);
    }

    const { rows: [limit] } = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM login_attempts
         WHERE email_hash = $1 AND NOT success AND at > clock_timestamp() - interval '15 minutes'
         OFFSET 4
       ) OR EXISTS (
         SELECT 1 FROM login_attempts
         WHERE ip = $2 AND NOT success AND at > clock_timestamp() - interval '15 minutes'
         OFFSET 4
       ) AS blocked`,
      [emailHash, ip],
    );
    const { rows: [account] } = await client.query(
      `SELECT ${userFields}, password_hash AS "passwordHash" FROM users WHERE lower(email) = $1`,
      [email],
    );

    let user = null;
    if (!limit.blocked) {
      const matches = await bcrypt.compare(password, account?.passwordHash ?? dummyHash);
      if (account && matches) {
        const { id, email: accountEmail, name, role, teamId } = account;
        user = { id, email: accountEmail, name, role, teamId };
      }

      await client.query(
        'INSERT INTO login_attempts (email_hash, ip, success, at) VALUES ($1, $2, $3, clock_timestamp())',
        [emailHash, ip, Boolean(user)],
      );
    }

    if (!user) {
      // Store only a known team and the source IP. The submitted email and
      // password never go into the audit record. audit.record() also checks the
      // login_failures alert rule, in this same transaction.
      await audit.record(client, auditReq, {
        category: 'security',
        action: 'login.failed',
        teamId: account?.teamId ?? null,
        details: { rateLimited: limit.blocked },
      });
    }

    await client.query('COMMIT');
    // Alerts raised by this attempt (login_failures); the controller sends them to GitHub.
    return { user, rateLimited: limit.blocked, pendingAlerts: auditReq.pendingAlerts ?? [] };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (failure) {
      rollbackError = failure;
    }
    throw error;
  } finally {
    client.release(rollbackError);
  }
}

async function findById(id) {
  const { rows } = await pool.query(
    `SELECT ${userFields} FROM users WHERE id = $1`,
    [id],
  );
  return rows[0];
}

module.exports = { authenticate, findById };
