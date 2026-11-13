// SQL for the audit log, the summary card and the monitoring page (S3). No HTTP here: the
// controller validates the query string with schema.js and passes clean values in.
// Every query is scoped to one team; teamId always comes from the session, never the client.
const { pool } = require('../../db/pool');
const { encodeCursor } = require('./schema');

const EXPORT_LIMIT = 10000; // one CSV download can never pull an unbounded table into memory

// What the API returns for one event (camelCase, as in docs/api-contract.md).
function toApi(row) {
  return {
    id: Number(row.id),
    at: row.at,
    actorLabel: row.actor_label,
    actorId: row.actor_id,
    category: row.category,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    details: row.details,
    requestId: row.request_id,
  };
}

// Builds "WHERE team_id = $1 AND ..." from the validated filters. Values are always parameters.
function whereClause(teamId, filters) {
  const params = [teamId];
  const parts = ['team_id = $1'];
  const add = (sql, value) => { params.push(value); parts.push(sql.replace('?', `$${params.length}`)); };
  if (filters.actor) add('lower(actor_label) = lower(?)', filters.actor);
  if (filters.action) add('action = ?', filters.action);
  if (filters.category) add('category = ?', filters.category);
  if (filters.from) add('at >= ?', filters.from);
  if (filters.to) add('at < ?', filters.to);
  if (filters.cursor) add('id < ?::bigint', filters.cursor);
  return { sql: parts.join(' AND '), params };
}

const COLUMNS = 'id, at, actor_label, actor_id, category, action, target_type, target_id, details, request_id';

// Newest first. Keyset paging on id: no gaps or duplicates even while new events arrive.
async function listEvents(teamId, filters, db = pool) {
  const { sql, params } = whereClause(teamId, filters);
  params.push(filters.limit + 1); // one extra row tells us whether there is a next page
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM audit_events WHERE ${sql} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, filters.limit);
  const nextCursor = rows.length > filters.limit ? encodeCursor(page[page.length - 1].id) : null;
  return { items: page.map(toApi), nextCursor };
}

async function exportEvents(teamId, filters, db = pool) {
  const { sql, params } = whereClause(teamId, { ...filters, cursor: undefined });
  params.push(EXPORT_LIMIT);
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM audit_events WHERE ${sql} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toApi);
}

async function summary(teamId, days, db = pool) {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE category = 'change')::int                          AS changes,
       count(*) FILTER (WHERE category = 'security')::int                        AS security_events,
       count(*) FILTER (WHERE action = 'login.failed')::int                      AS failed_logins,
       count(*) FILTER (WHERE category = 'change' AND details->>'env' = 'prod')::int AS prod_changes,
       (SELECT count(*) FROM alerts WHERE team_id = $1 AND status = 'open')::int AS alerts_open
     FROM audit_events
     WHERE team_id = $1 AND at > now() - make_interval(days => $2)`,
    [teamId, days],
  );
  const r = rows[0];
  return {
    days,
    changes: r.changes,
    securityEvents: r.security_events,
    failedLogins: r.failed_logins,
    prodChanges: r.prod_changes,
    alertsOpen: r.alerts_open,
  };
}

// Security dashboard. server.error and rate_limit.hit are security events written with
// audit.recordSecurity() by the error handler and the rate limiters.
async function monitoring(teamId, hours, db = pool) {
  const window = [teamId, hours];
  const since = 'at > now() - make_interval(hours => $2)';

  const totals = db.query(
    `SELECT
       count(*) FILTER (WHERE action = 'login.failed')::int   AS failed_logins,
       count(*) FILTER (WHERE action = 'access.denied')::int  AS forbidden,
       count(*) FILTER (WHERE action = 'server.error')::int   AS server_errors,
       count(*) FILTER (WHERE action = 'rate_limit.hit')::int AS rate_limited,
       (SELECT count(*) FROM alerts
         WHERE team_id = $1 AND status = 'failed'
           AND updated_at > now() - make_interval(hours => $2))::int AS alert_failures
     FROM audit_events
     WHERE team_id = $1 AND category = 'security' AND ${since}`,
    window,
  );

  const topIps = db.query(
    `SELECT ip, count(*)::int AS count
       FROM audit_events
      WHERE team_id = $1 AND action = 'login.failed' AND ip IS NOT NULL AND ${since}
      GROUP BY ip ORDER BY count DESC, ip LIMIT 5`,
    window,
  );

  // One point per hour, including hours with nothing in them, so the chart has no holes.
  const series = db.query(
    `SELECT h.hour,
            count(e.id) FILTER (WHERE e.action = 'login.failed')::int  AS failed_logins,
            count(e.id) FILTER (WHERE e.action = 'access.denied')::int AS forbidden,
            count(e.id) FILTER (WHERE e.action = 'server.error')::int  AS server_errors
       FROM generate_series(date_trunc('hour', now()) - make_interval(hours => $2 - 1),
                            date_trunc('hour', now()), interval '1 hour') AS h(hour)
       LEFT JOIN audit_events e
              ON e.team_id = $1 AND e.category = 'security'
             AND e.at >= h.hour AND e.at < h.hour + interval '1 hour'
      GROUP BY h.hour ORDER BY h.hour`,
    window,
  );

  const [t, ips, s] = await Promise.all([totals, topIps, series]);
  const r = t.rows[0];
  return {
    hours,
    failedLogins: r.failed_logins,
    forbidden: r.forbidden,
    serverErrors: r.server_errors,
    rateLimited: r.rate_limited,
    alertFailures: r.alert_failures,
    topFailedLoginIps: ips.rows,
    series: s.rows.map((row) => ({
      hour: row.hour,
      failedLogins: row.failed_logins,
      forbidden: row.forbidden,
      serverErrors: row.server_errors,
    })),
  };
}

module.exports = { listEvents, exportEvents, summary, monitoring, toApi, EXPORT_LIMIT };
