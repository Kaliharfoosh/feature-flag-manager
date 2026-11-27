// Optional S1 notification. Runs after commit and never includes the API key secret.
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { pool } = require('../db/pool');
let client;
const sendEmail = command => (client ??= new SESClient({ maxAttempts: 1,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 },
  ...(process.env.S1_AWS_ENDPOINT && { endpoint: process.env.S1_AWS_ENDPOINT }) })).send(command);

async function notify(req, change, { settings = process.env, query = (...args) => pool.query(...args), send = sendEmail } = {}) {
  if (!settings.SES_FROM_ADDRESS || change.env !== 'prod' || !['key.created', 'key.revoked'].includes(change.action)) return;
  try {
    const { rows } = await query('SELECT email FROM users WHERE team_id = $1 AND role = $2', [req.user.teamId, 'admin']);
    for (const { email } of rows) {
      await send(new SendEmailCommand({ Source: settings.SES_FROM_ADDRESS,
        Destination: { ToAddresses: [email] }, Message: {
          Subject: { Data: `Feature Flag Manager: production API key ${change.action === 'key.created' ? 'created' : 'revoked'}`, Charset: 'UTF-8' },
          Body: { Text: { Data: `A production API key was ${change.action === 'key.created' ? 'created' : 'revoked'} by ${req.user.email}.\nKey prefix: ${change.prefix}\nRequest: ${req.id}\nThe key secret is never included in notifications.`, Charset: 'UTF-8' } },
        } }));
    }
  } catch {
    (req.log || console).warn({ action: 'security-email.failed', requestId: req.id }, 'Security email failed after commit');
  }
}
module.exports = { notify };
