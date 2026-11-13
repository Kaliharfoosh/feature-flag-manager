// GitHub issues for alerts (S3). No HTTP routes here: data and the GitHub call only.
//
// Lifecycle of an alert row: open -> sending -> sent | failed. failed can be retried by an Admin.
//   1. audit.record() inserts the alert as "open" inside the caller's transaction and adds its id
//      to req.pendingAlerts.
//   2. After COMMIT the caller runs `await deliverPending(req)`. Each alert is claimed atomically
//      (open/failed -> sending), so two requests can never open two issues for one alert, and an
//      alert from a rolled-back transaction simply doesn't exist, so nothing is sent.
//   3. GitHub is called with a 3-second timeout (nothing runs in the background on Vercel).
//      Success stores the issue number and URL; any failure stores a short last_error.
//
// The token is read from GITHUB_TOKEN only. It is never logged, stored or put in an error.
// Use a fine-grained token limited to "Issues: write" on this one repository, set to expire
// after the week 12 demo.
const { pool } = require('../../db/pool');

const TIMEOUT_MS = 3000;
const STALE_SENDING = '2 minutes'; // a "sending" row older than this was cut off mid-request
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ERROR = 300;

function upstreamError(message) {
  const err = new Error(message);
  err.status = 502;
  err.code = 'UPSTREAM_FAILED';
  return err;
}

// Text from users (flag names, emails) ends up in the issue. These keep it inert:
// no @mentions that notify people, no breaking out of code spans or the JSON block.
const noMentions = (text) => String(text).replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9])/g, '$1@​');
const inline = (value) => (value === null || value === undefined || value === ''
  ? '—'
  : `\`${noMentions(String(value).replace(/[`\r\n]/g, ' ').slice(0, 200))}\``);

function issueTitle(alert) {
  return noMentions(String(alert.title).replace(/[\r\n]+/g, ' ')).slice(0, 200);
}

function issueBody(alert, event) {
  // details was redacted by shared/audit.js before it was stored; ` keeps it valid JSON
  // while making a ``` fence inside it impossible.
  const details = JSON.stringify(event.details ?? {}, null, 2).replace(/`/g, '\\u0060');
  return [
    `**Rule:** ${inline(alert.rule)}`,
    `**Action:** ${inline(event.action)}`,
    `**Actor:** ${inline(event.actor_label)}`,
    `**Target:** ${inline(event.target_type)} ${inline(event.target_id)}`,
    `**When:** ${inline(new Date(event.at).toISOString())}`,
    `**Request ID:** ${inline(event.request_id)}`,
    `**Audit event:** ${inline(event.id)}`,
    '',
    'Details (redacted):',
    '```json',
    noMentions(details),
    '```',
    '',
    '_Raised automatically by Feature Flag Manager._',
  ].join('\n');
}

// One POST to the GitHub REST API. Resolves { number, url } or throws a 502 UPSTREAM_FAILED.
async function createIssue({ title, body }, { fetchImpl = fetch, env = process.env } = {}) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) throw upstreamError('GitHub is not configured (GITHUB_TOKEN and GITHUB_REPO).');
  if (!REPO_PATTERN.test(repo)) throw upstreamError('GITHUB_REPO must look like owner/repo.');

  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'feature-flag-manager',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ title, body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw upstreamError(`GitHub did not answer within ${TIMEOUT_MS / 1000} s.`);
    }
    throw upstreamError(`GitHub could not be reached (${err.cause?.code ?? err.name}).`);
  }

  let data = {};
  try { data = await res.json(); } catch { /* an empty or non-JSON answer keeps data = {} */ }
  if (res.status !== 201 || !Number.isInteger(data.number)) {
    const reason = typeof data.message === 'string' ? `: ${data.message}` : '';
    throw upstreamError(`GitHub answered ${res.status}${reason}`.slice(0, MAX_ERROR));
  }
  return { number: data.number, url: data.html_url };
}

// Claims one alert and sends it. Resolves the updated alert row, or null when there was nothing
// to claim (already sent, being sent right now, or never committed). Throws 502 when GitHub fails,
// after the row has been marked failed.
async function deliver(alertId, { db = pool, ...options } = {}) {
  const { rows: [claimed] } = await db.query(
    `UPDATE alerts SET status = 'sending', updated_at = now()
      WHERE id = $1
        AND (status IN ('open', 'failed')
             OR (status = 'sending' AND updated_at < now() - $2::interval))
      RETURNING id, rule, title, audit_event_id`,
    [alertId, STALE_SENDING],
  );
  if (!claimed) return null;

  const { rows: [event] } = await db.query(
    `SELECT id, at, actor_label, action, target_type, target_id, details, request_id
       FROM audit_events WHERE id = $1`,
    [claimed.audit_event_id],
  );

  // Only the GitHub call is inside the try: once the issue exists, a database error below must
  // not mark the alert "failed", or a retry would open a second issue.
  let issue;
  try {
    issue = await createIssue({ title: issueTitle(claimed), body: issueBody(claimed, event) }, options);
  } catch (err) {
    const message = (err.code === 'UPSTREAM_FAILED' ? err.message : 'Unexpected error while creating the issue.').slice(0, MAX_ERROR);
    await db.query(
      `UPDATE alerts SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
      [alertId, message],
    );
    throw err.code === 'UPSTREAM_FAILED' ? err : upstreamError(message);
  }

  const { rows } = await db.query(
    `UPDATE alerts SET status = 'sent', github_issue_number = $2, github_issue_url = $3,
            last_error = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [alertId, issue.number, issue.url],
  );
  return rows[0];
}

// For callers, right after COMMIT. Never throws: a GitHub problem must not fail the change the
// user just made. Failed alerts stay "failed" and show on the monitoring card for a retry.
async function deliverPending(req, options) {
  const ids = (req && req.pendingAlerts) || [];
  if (req) req.pendingAlerts = [];
  for (const id of ids) {
    try {
      await deliver(id, options);
    } catch (err) {
      ((req && req.log) || console).warn({ alertId: id, reason: err.message }, 'alert: GitHub issue not created');
    }
  }
}

// The alert for one audit event, scoped to the team (another team's id answers 404 upstream).
async function findAlertForEvent(teamId, auditEventId, db = pool) {
  const { rows } = await db.query(
    'SELECT * FROM alerts WHERE team_id = $1 AND audit_event_id = $2 ORDER BY created_at LIMIT 1',
    [teamId, auditEventId],
  );
  return rows[0] ?? null;
}

// API shape (docs/api-contract.md, POST /alerts/:auditId/github-issue).
function toApi(row) {
  return {
    alertId: row.id,
    auditEventId: Number(row.audit_event_id),
    rule: row.rule,
    title: row.title,
    status: row.status,
    githubIssueNumber: row.github_issue_number,
    githubIssueUrl: row.github_issue_url,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

async function listAlerts(teamId, db = pool) {
  const { rows } = await db.query(
    'SELECT * FROM alerts WHERE team_id = $1 ORDER BY created_at DESC, id LIMIT 50',
    [teamId],
  );
  return rows.map(toApi);
}

module.exports = {
  createIssue, deliver, deliverPending, findAlertForEvent, listAlerts, toApi,
  issueTitle, issueBody, TIMEOUT_MS,
};
